(async function () {
  const isCOSAvailable = 'crossOriginStorage' in navigator;
  console.log('COS Loader: isCOSAvailable =', isCOSAvailable);

  // Manifest is injected by the Vite plugin
  // @ts-ignore
  const manifest = __COS_MANIFEST__;

  const { base, entry, chunks } = manifest;
  const mainEntry = entry;

  if (!mainEntry) {
    console.warn('COS Loader: Missing entry in manifest.');
    return;
  }

  // Identify managed chunks
  const chunksToLoad = Object.entries(chunks || {}).map(([fileName, hash]) => ({
    fileName,
    hash,
    file: `${base}${fileName}`,
  }));

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

  async function getChunkBlobUrl(chunk) {
    let blob = await getBlobFromCOS(chunk.hash);
    if (blob) {
      console.log(`COS Loader: ${chunk.fileName} found in COS`);
      blob = new Blob([blob], { type: 'text/javascript' });
    }
    if (!blob) {
      console.log(`COS Loader: ${chunk.file} not in COS, fetching...`);
      try {
        const resp = await fetch(chunk.file);
        if (!resp.ok) throw new Error(`Status ${resp.status}`);
        const rawBlob = await resp.blob();
        blob = new Blob([rawBlob], { type: 'text/javascript' });
        await storeBlobInCOS(blob, chunk.hash);
      } catch (e) {
        console.error(`COS Loader: Failed to fetch ${chunk.file}`, e);
        return null;
      }
    }

    // Convert blob to Blob URL
    // Blob URLs are synchronous and share the page origin,
    // which helps with module resolution in complex graphs.
    return URL.createObjectURL(blob);
  }

  // Initialize
  try {
    console.log('COS Loader: Starting app...');

    // Resolve all chunks to Blob URLs
    const importMap = { imports: {} };

    // Set up unmanaged dependencies correctly so Blob URLs can resolve them.
    for (const fileName of manifest.unmanaged || []) {
      const bareSpecifier = `coschunk-${fileName.replace(/\//g, '-')}`;
      importMap.imports[bareSpecifier] =
        window.location.origin + base + fileName;
    }

    console.log(`COS Loader: Loading ${chunksToLoad.length} chunks...`);
    const loadPromises = chunksToLoad.map(async (chunk) => {
      const blobUrl = await getChunkBlobUrl(chunk);
      if (blobUrl) {
        // Use a hyphenated prefix and replace all slashes to ensure it's treated
        // as a truly bare specifier, bypassing hierarchical/protocol checks.
        const bareSpecifier = `coschunk-${chunk.fileName.replace(/\//g, '-')}`;
        importMap.imports[bareSpecifier] = blobUrl;
      }
    });

    await Promise.all(loadPromises);

    // Inject Import Map
    const script = document.createElement('script');
    script.type = 'importmap';
    script.textContent = JSON.stringify(importMap, null, 2);
    document.head.appendChild(script);

    console.log('COS Loader: Import Map injected');

    // Import the main entry via its bare specifier to ensure it resolves
    // through the import map and can find other managed chunks.
    const entrySpecifier = `coschunk-${mainEntry.replace(/\//g, '-')}`;

    // Small delay to ensure the browser has fully registered the
    // import map before resolving the first module.
    setTimeout(() => {
      import(entrySpecifier).catch((err) => {
        console.error('COS Loader: Failed to start app', err);
      });
    }, 0);
  } catch (err) {
    console.error('COS Loader: Initialization failed', err);
  }
})();
