export function makePdf(o: { title?: string; subtitle?: string; accent?: string; footer?: string; sections?: { heading?: string; paras?: string[]; bullets?: string[]; code?: string[] }[] }): Uint8Array;
export function pdfSafe(s: unknown): string;
export function b64wrap(bytes: Uint8Array): string;
export function mixedBody(text: string, attachments: { filename: string; content: Uint8Array; type?: string }[], boundary?: string): { contentType: string; body: string };
