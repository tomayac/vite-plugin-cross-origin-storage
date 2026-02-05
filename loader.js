(async function () {
  await new Promise((resolve) => setTimeout(resolve, 100));

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
        console.log('COS Loader: Stored bundle in COS', hash);
      }
    } catch (err) {
      console.error('COS Loader: Failed to store in COS', err);
    }
  }

  // Load all managed chunks in parallel
  if (chunksToLoad.length > 0) {
    const importMap = { imports: {} };

    // Prefix mapping: Handles all unmanaged chunks automatically.
    // Longest prefix wins in Import Maps, so specific managed entries below take precedence.
    // We assume all chunks are in the same relative directory as the managed ones.
    const firstChunk = chunksToLoad[0];
    const assetsDir = firstChunk.fileName.substring(
      0,
      firstChunk.fileName.lastIndexOf('/') + 1
    );
    const assetsUrl = firstChunk.file.substring(
      0,
      firstChunk.file.lastIndexOf('/') + 1
    );
    if (assetsDir && assetsUrl) {
      importMap.imports[assetsDir] = assetsUrl;
    }

    await Promise.all(
      chunksToLoad.map(async (chunk) => {
        let url = null;

        const cosBlob = await getBlobFromCOS(chunk.hash);
        if (cosBlob) {
          console.log(`COS Loader: Loaded ${chunk.file} from COS!`);
          url = URL.createObjectURL(
            new Blob([cosBlob], { type: 'text/javascript' })
          );
        } else {
          console.log(`COS Loader: ${chunk.file} not in COS, fetching...`);
          try {
            const response = await fetch(chunk.file);
            if (response.ok) {
              const blob = await response.blob();
              url = URL.createObjectURL(
                new Blob([blob], { type: 'text/javascript' })
              );
              // Store in COS for next time
              storeBlobInCOS(blob, chunk.hash);
            } else {
              console.error(
                `COS Loader: Fetch failed with status ${response.status}`
              );
            }
          } catch (e) {
            console.error(
              `COS Loader: Network fetch failed for ${chunk.file}`,
              e
            );
          }
        }

        if (url) {
          // Use a Data URL shim to decouple the import graph.
          // This ensures that the circular dependency between React and React-DOM
          // doesn't cause a lockout/deadlock during the module graph instantiation.
          const shim = `export * from "${url}";${chunk.hasDefault ? `export { default } from "${url}";` : ''}`;
          const shimUrl = `data:text/javascript;base64,${btoa(shim)}`;

          // Map the virtual bare specifier to the shim
          importMap.imports[`cos-id/${chunk.fileName}`] = shimUrl;

          // Also set global if anyone still needs it (legacy)
          if (chunk.globalVar) {
            window[chunk.globalVar] = url;
          }
        }
      })
    );

    // Inject the importmap
    if (Object.keys(importMap.imports).length > 0) {
      const imScript = document.createElement('script');
      imScript.type = 'importmap';
      imScript.textContent = JSON.stringify(importMap);
      document.head.appendChild(imScript);
    }
  }

  // Start App
  try {
    console.log('COS Loader: Starting app...');
    // Ensure the importmap is registered before importing
    await new Promise((resolve) => setTimeout(resolve, 0));
    await import(mainEntry.file);
  } catch (err) {
    console.error('COS Loader: Failed to start app', err);
  }
})();
