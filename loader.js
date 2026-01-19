(async function () {
  await new Promise(resolve => setTimeout(resolve, 100));

  const isCOSAvailable = 'crossOriginStorage' in navigator;
  console.log('COS Loader: isCOSAvailable =', isCOSAvailable);

  // Manifest is injected by the Vite plugin
  // @ts-ignore
  const manifest = __COS_MANIFEST__;

  const mainEntry = manifest && manifest['index'];
  if (!mainEntry) {
    console.warn('COS Loader: Missing main entry in manifest.');
    return;
  }

  // Identify managed chunks (anything with a hash)
  const chunksToLoad = Object.values(manifest).filter(item => item.hash);

  async function getBlobFromCOS(hash) {
    if (!isCOSAvailable) return null;
    try {
      const handles = await navigator.crossOriginStorage.requestFileHandles([
        { algorithm: 'SHA-256', value: hash },
      ]);
      if (handles && handles.length > 0) {
        return await handles[0].getFile();
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') console.error('COS Loader: Error checking COS', err);
    }
    return null;
  }

  async function storeBlobInCOS(blob, hash) {
    if (!isCOSAvailable) return;
    try {
      const handles = await navigator.crossOriginStorage.requestFileHandles(
        [{ algorithm: 'SHA-256', value: hash }],
        { create: true }
      );
      if (handles && handles.length > 0) {
        const writable = await handles[0].createWritable();
        await writable.write(blob);
        await writable.close();
        console.log('COS Loader: Stored bundle in COS', hash);
      }
    } catch (err) {
      console.error('COS Loader: Failed to store in COS', err);
    }
  }

  // Load all managed chunks in parallel
  // If COS is not available, we skip this and fall back to native network loading via the import() rewrites.
  if (isCOSAvailable && chunksToLoad.length > 0) {
    await Promise.all(chunksToLoad.map(async (chunk) => {
      let url = null;

      const cosBlob = await getBlobFromCOS(chunk.hash);
      if (cosBlob) {
        console.log(`COS Loader: Loaded ${chunk.file} from COS!`);
        url = URL.createObjectURL(new Blob([cosBlob], { type: 'application/javascript' }));
      } else {
        console.log(`COS Loader: ${chunk.file} not in COS, fetching...`);
        try {
          const response = await fetch(chunk.file);
          if (response.ok) {
            const blob = await response.blob();
            url = URL.createObjectURL(new Blob([blob], { type: 'application/javascript' }));
            // Store in COS for next time
            storeBlobInCOS(blob, chunk.hash);
          } else {
            console.error(`COS Loader: Fetch failed with status ${response.status}`);
          }
        } catch (e) {
          console.error(`COS Loader: Network fetch failed for ${chunk.file}`, e);
        }
      }

      // Set global variable if we have a URL
      if (url && chunk.globalVar) {
        window[chunk.globalVar] = url;
      }
    }));
  }

  // Start App
  try {
    console.log('COS Loader: Starting app...');
    await import(mainEntry.file);
  } catch (err) {
    console.error('COS Loader: Failed to start app', err);
  }
})();
