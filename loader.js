(async function () {
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
  const chunksToLoad = Object.values(manifest).filter((item) => item.hash);

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
      if (err.name !== 'NotFoundError')
        console.error('COS Loader: Error checking COS', err);
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
        console.log('COS Loader: Stored chunk in COS', hash);
      }
    } catch (err) {
      console.error('COS Loader: Failed to store in COS', err);
    }
  }

  async function getChunkDataUrl(chunk) {
    let blob = await getBlobFromCOS(chunk.hash);
    if (!blob) {
      console.log(`COS Loader: ${chunk.file} not in COS, fetching...`);
      try {
        const resp = await fetch(chunk.file);
        if (!resp.ok) throw new Error(`Status ${resp.status}`);
        blob = await resp.blob();
        await storeBlobInCOS(blob, chunk.hash);
      } catch (e) {
        console.error(`COS Loader: Failed to fetch ${chunk.file}`, e);
        return null;
      }
    }

    // Convert blob to Data URL
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  // Initialize
  try {
    console.log('COS Loader: Starting app...');

    // Resolve all chunks to Data URLs
    const importMap = { imports: {} };
    const loadPromises = chunksToLoad.map(async (chunk) => {
      const dataUrl = await getChunkDataUrl(chunk);
      if (dataUrl) {
        // Use a bare specifier prefix to avoid hierarchical resolution issues
        importMap.imports[`cos-chunk:${chunk.fileName}`] = dataUrl;
      }
    });

    await Promise.all(loadPromises);

    // Inject Import Map
    const script = document.createElement('script');
    script.type = 'importmap';
    script.textContent = JSON.stringify(importMap);
    document.head.appendChild(script);

    console.log('COS Loader: Import Map injected');

    // Import the main entry.
    // If the entry itself were managed, we would use cos-chunk: prefix here too.
    // For now, it's loaded via its absolute path from the server,
    // and its internal imports (rewritten by the plugin) will use cos-chunk:
    const entryUrl = mainEntry.file;
    await import(entryUrl);

  } catch (err) {
    console.error('COS Loader: Failed to start app', err);
  }
})();
