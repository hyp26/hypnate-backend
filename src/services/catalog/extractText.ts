import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export async function extractTextFromFile(buffer: Buffer, mimetype: string): Promise<string> {
  if (mimetype === "application/pdf") {
    // pdf-parse v2 replaced the old callable-function API with a class:
    // new PDFParse({ data }).getText() instead of pdfParse(buffer).
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimetype === "application/msword"
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  if (mimetype === "text/plain") {
    return buffer.toString("utf-8");
  }

  throw new Error(`Unsupported file type for text extraction: ${mimetype}`);
}