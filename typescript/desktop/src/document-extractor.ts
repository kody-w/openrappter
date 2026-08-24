import { readFile } from "node:fs/promises";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

const MAX_TEXT_CHARS = 100_000;

async function main(): Promise<void> {
  const [mimeType, filename] = process.argv.slice(2);
  if (!mimeType || !filename) {
    throw new Error("Document extractor requires a MIME type and file.");
  }
  const buffer = await readFile(filename);
  let text: string;
  if (mimeType === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo({ parsePageInfo: false });
      if (info.total > 200) {
        throw new Error("PDF evidence must contain at most 200 pages.");
      }
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else {
    throw new Error(`Unsupported rich document type: ${mimeType}`);
  }
  process.stdout.write(
    JSON.stringify({
      text: text.replace(/\0/g, "").slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
