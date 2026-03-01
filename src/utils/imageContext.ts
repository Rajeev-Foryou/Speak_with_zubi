export interface DisplayedImageContext {
  src: string | null;
  altText: string;
  groundingContext: string;
  groundingKeywords: string[];
}

const imageModules = import.meta.glob("../images/*.{png,jpg,jpeg,webp,gif}", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const sortedImagePaths = Object.keys(imageModules).sort((a, b) =>
  a.localeCompare(b),
);

const STOP_WORDS = new Set([
  "image",
  "img",
  "photo",
  "picture",
  "test",
  "sample",
  "final",
  "copy",
  "new",
  "file",
]);

function extractKeywordsFromPath(filePath: string): string[] {
  const fileName = filePath.split("/").pop() || "";
  const nameOnly = fileName.replace(/\.[^/.]+$/, "");

  const tokens = nameOnly
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .filter((item) => !STOP_WORDS.has(item));

  return Array.from(new Set(tokens));
}

function buildImageContext(pathKey: string | undefined): DisplayedImageContext {
  if (!pathKey) {
    return {
      src: null,
      altText: "Displayed image",
      groundingContext:
        "The displayed image is unknown. Ask only about visible objects, colors, and background in the picture.",
      groundingKeywords: ["picture", "color", "object", "background"],
    };
  }

  const src = imageModules[pathKey] || null;
  const keywords = extractKeywordsFromPath(pathKey);

  const groundingKeywords =
    keywords.length > 0 ? keywords : ["picture", "color", "object", "background"];

  const humanReadable = groundingKeywords.join(", ");

  return {
    src,
    altText: `Child-friendly image showing ${humanReadable}`,
    groundingContext:
      `Current displayed image hints from filename: ${humanReadable}. Ask only about what is visible in this image and avoid unrelated topics.`,
    groundingKeywords,
  };
}

const selectedPath = sortedImagePaths[0];
const selectedImageContext = buildImageContext(selectedPath);

export function getDisplayedImageContext(): DisplayedImageContext {
  return selectedImageContext;
}
