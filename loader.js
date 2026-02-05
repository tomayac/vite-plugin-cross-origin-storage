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
  const chunksByFileName = {};
  chunksToLoad.forEach(c => chunksByFileName[c.fileName] = c);

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

  // Cache for resolved URLs
  const resolvedUrls = {}; // fileName -> { blobUrl, shimUrl }
  const processing = new Set();

  // Cache for raw text content
  const rawContent = {}; // fileName -> string

  async function loadRawContent(chunk) {
    if (rawContent[chunk.fileName]) return rawContent[chunk.fileName];

    let blob = await getBlobFromCOS(chunk.hash);
    if (!blob) {
      console.log(`COS Loader: ${chunk.file} not in COS, fetching...`);
      try {
        const resp = await fetch(chunk.file);
        if (!resp.ok) throw new Error(`Status ${resp.status}`);
        blob = await resp.blob();
        storeBlobInCOS(blob, chunk.hash);
      } catch (e) {
        console.error(`COS Loader: Failed to fetch ${chunk.file}`, e);
        return null;
      }
    }
    const text = await blob.text();
    rawContent[chunk.fileName] = text;
    return text;
  }

  async function resolveChunk(fileName) {
    if (resolvedUrls[fileName]) return resolvedUrls[fileName];
    if (processing.has(fileName)) {
      console.warn(`COS Loader: Circular dependency detected for ${fileName}. Breaking cycle with placeholder (may fail).`);
      // We cannot solve cycles with Direct Data Injection easily. 
      // Returning null might cause failure, but we hope merging chunks avoided this.
      return null; 
    }

    processing.add(fileName);
    const chunk = chunksByFileName[fileName];
    if (!chunk) {
      // Unmanaged dependency? Should have been handled by absolute/base logic but we reverted to ./
      // If it's ./unmanaged.js, we don't have it in manifest.
      // We can't inject it.
      console.warn(`COS Loader: Unknown dependency ${fileName}`);
      return null;
    }

    let code = await loadRawContent(chunk);
    if (!code) return null;

    // Find dependencies in the code: import ... from "./dep.js"
    // Regex matches the one used in build: `from "./..."`
    const depRegex = /from\s+['"]\.\/([^'"]+)['"]/g;
    let match;
    const deps = new Set();
    while ((match = depRegex.exec(code)) !== null) {
      deps.add(match[1]); // The filename relative to current
    }

    // Resolve dependencies recursively
    const replacements = [];
    for (const depName of deps) {
      const res = await resolveChunk(depName);
      if (res && res.shimUrl) {
        replacements.push({ depName, url: res.shimUrl });
      }
    }

    // Replace in code
    for (const { depName, url } of replacements) {
      // Replace ALL occurrences
      // We need to be careful with regex replacement safer:
      // Replace `from "./depName"` with `from "url"`
      code = code.split(`from "./${depName}"`).join(`from "${url}"`);
      code = code.split(`from './${depName}'`).join(`from "${url}"`);

      // Also dynamic imports: import("./depName")
      code = code.split(`import("./${depName}")`).join(`import("${url}")`);
      code = code.split(`import('./${depName}')`).join(`import("${url}")`);
    }

    const blob = new Blob([code], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    // Create Shim
    const shim = `export * from "${blobUrl}";${chunk.hasDefault ? `export { default } from "${blobUrl}";` : ''}`;
    const shimUrl = `data:text/javascript;base64,${btoa(shim)}`;

    resolvedUrls[fileName] = { blobUrl, shimUrl };
    processing.delete(fileName);
    return resolvedUrls[fileName];
  }

  // Initialize
  try {
    console.log('COS Loader: Starting app...');
    // Resolve main entry
    const entryFileName = mainEntry.fileName;
    // We assume mainEntry doesn't need to be shimmed for ITSELF, but its deps do.
    // Actually resolveChunk returns the shimUrl.
    const res = await resolveChunk(entryFileName);

    if (res) {
      // Import the SHIM of the main entry
      await import(res.shimUrl);
    } else {
      console.error('COS Loader: Failed to resolve main entry');
    }
  } catch (err) {
    console.error('COS Loader: Failed to start app', err);
  }
})();
