// FreeZone BD - image upload (imgbb). Only the returned link is saved in Firebase, never the image itself.
const IMGBB_API_KEY = "aede02b305570da9ff878b94285d9623";

/**
 * Uploads an image Blob/File and resolves with its direct link (https://i.ibb.co/...).
 * options.onProgress(fraction)  - called with 0..1 while the bytes are being sent
 * options.signal                - an AbortSignal; aborting it cancels the upload (the promise rejects with AbortError)
 */
export function uploadToImgbb(blob, filename = "image.jpg", { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new DOMException("Upload cancelled", "AbortError"));

    const form = new FormData();
    form.append("image", blob, filename);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`);
    xhr.timeout = 120000;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      let json = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch (error) {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300 && json && json.success && json.data && json.data.url) {
        if (onProgress) onProgress(1);
        resolve(json.data.url);
      } else {
        reject(new Error((json && json.error && json.error.message) || "Upload failed"));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          xhr.abort();
          reject(new DOMException("Upload cancelled", "AbortError"));
        },
        { once: true }
      );
    }

    xhr.send(form);
  });
}

/** Shrinks a picked image (longest side max 1280px) into a JPEG Blob, so uploads are small and fast. */
export function prepareImage(file, maxDimension = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This file is not a valid image."));
    };
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not process the image."))),
        "image/jpeg",
        quality
      );
    };
    img.src = objectUrl;
  });
}