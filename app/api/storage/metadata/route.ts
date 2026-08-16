import { NextResponse } from "next/server";
import {
  lookupPaperMetadata,
  type PaperMetadataBlockInput,
} from "@/lib/paper-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    title?: unknown;
    text?: unknown;
    metadataTitle?: unknown;
    blocks?: unknown;
    pageHeight?: unknown;
  };
  const blocks = Array.isArray(body.blocks)
    ? (body.blocks.slice(0, 80) as Array<Record<string, unknown>>)
        .map((block): PaperMetadataBlockInput => ({
          text:
            typeof block.text === "string" ? block.text.slice(0, 500) : undefined,
          fontSize:
            typeof block.fontSize === "number" ? block.fontSize : undefined,
          top: typeof block.top === "number" ? block.top : undefined,
          kind: typeof block.kind === "string" ? block.kind.slice(0, 20) : undefined,
        }))
    : undefined;
  try {
    const metadata = await lookupPaperMetadata({
      title: typeof body.title === "string" ? body.title.slice(0, 500) : undefined,
      text: typeof body.text === "string" ? body.text.slice(0, 60000) : undefined,
      metadataTitle:
        typeof body.metadataTitle === "string"
          ? body.metadataTitle.slice(0, 500)
          : undefined,
      blocks,
      pageHeight: typeof body.pageHeight === "number" ? body.pageHeight : undefined,
    });
    return NextResponse.json(metadata, { headers: noStore });
  } catch {
    return NextResponse.json({}, { headers: noStore });
  }
}
