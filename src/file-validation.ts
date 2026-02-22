/**
 * File type validation using magic bytes (file signatures)
 * Prevents malicious files disguised with fake extensions
 */

interface FileSignature {
  mime: string;
  pattern: number[];
  offset?: number;
}

// Common file signatures (magic bytes)
// https://en.wikipedia.org/wiki/List_of_file_signatures
const FILE_SIGNATURES: FileSignature[] = [
  // Images
  { mime: 'image/jpeg', pattern: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', pattern: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/gif', pattern: [0x47, 0x49, 0x46, 0x38] }, // GIF87a or GIF89a
  { mime: 'image/webp', pattern: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF header (need to check WEBP at offset 8)

  // Documents
  { mime: 'application/pdf', pattern: [0x25, 0x50, 0x44, 0x46] }, // %PDF

  // Videos
  { mime: 'video/mp4', pattern: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], offset: 0 }, // ftyp
  { mime: 'video/mp4', pattern: [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70], offset: 0 }, // ftyp variant

  // Audio
  { mime: 'audio/mpeg', pattern: [0xFF, 0xFB] }, // MP3
  { mime: 'audio/mpeg', pattern: [0x49, 0x44, 0x33] }, // MP3 with ID3 tag
  { mime: 'audio/ogg', pattern: [0x4F, 0x67, 0x67, 0x53] }, // OggS
];

/**
 * Validate file type by checking magic bytes
 * Returns the detected MIME type or null if no match
 */
export function detectFileType(buffer: Buffer): string | null {
  for (const sig of FILE_SIGNATURES) {
    const offset = sig.offset || 0;
    let matches = true;

    // Check if buffer is large enough
    if (buffer.length < offset + sig.pattern.length) {
      continue;
    }

    // Compare bytes
    for (let i = 0; i < sig.pattern.length; i++) {
      if (buffer[offset + i] !== sig.pattern[i]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      // Special case for WebP - need to verify WEBP at offset 8
      if (sig.mime === 'image/webp') {
        const webpCheck = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
        if (buffer.length >= 12) {
          let isWebp = true;
          for (let i = 0; i < webpCheck.length; i++) {
            if (buffer[8 + i] !== webpCheck[i]) {
              isWebp = false;
              break;
            }
          }
          if (isWebp) return sig.mime;
        }
        continue;
      }

      return sig.mime;
    }
  }

  return null;
}

/**
 * Check if detected MIME type is compatible with claimed MIME type
 * Allows for minor variations (e.g., image/jpeg vs image/jpg)
 */
export function isMimeTypeCompatible(detected: string, claimed: string): boolean {
  if (detected === claimed) return true;

  // Normalize MIME types
  const normalizeJpeg = (mime: string) => mime.replace('image/jpg', 'image/jpeg');
  const detectedNorm = normalizeJpeg(detected);
  const claimedNorm = normalizeJpeg(claimed);

  if (detectedNorm === claimedNorm) return true;

  // Allow generic application/octet-stream for documents
  if (claimed === 'application/octet-stream') return true;

  // Allow MP4 variants
  if (detected === 'video/mp4' && (claimed === 'video/mp4' || claimed === 'video/quicktime')) {
    return true;
  }

  return false;
}

/**
 * Validate that a file buffer matches its claimed MIME type
 * Returns true if valid, false if mismatch detected
 */
export function validateFileType(buffer: Buffer, claimedMimetype: string): boolean {
  const detected = detectFileType(buffer);

  // If we can't detect the type, allow it (benefit of the doubt)
  // This prevents rejecting valid but uncommon file types
  if (!detected) {
    return true;
  }

  return isMimeTypeCompatible(detected, claimedMimetype);
}
