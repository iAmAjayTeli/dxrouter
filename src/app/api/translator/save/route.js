import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { TRANSLATOR_LOGS_DIR } from "@/lib/dataDir";
import { redactString } from "@/lib/security/redact";

export async function POST(request) {
  try {
    const { file, content } = await request.json();

    if (!file || content === undefined) {
      return NextResponse.json({ success: false, error: "File and content required" }, { status: 400 });
    }

    // Security: only allow specific filenames
    const allowedFiles = [
      "1_req_client.json",
      "2_req_source.json",
      "3_req_openai.json",
      "4_req_target.json",
      "5_res_provider.txt",
      "6_res_openai.txt",
      "7_res_client.txt",
      "7_res_client.json",
    ];

    if (!allowedFiles.includes(file)) {
      return NextResponse.json({ success: false, error: "Invalid file name" }, { status: 400 });
    }

    // Under the one data root, not `process.cwd()`: these traces are diagnostics,
    // and a repo-relative store escapes DXR_DATA_DIR entirely.
    const logsDir = TRANSLATOR_LOGS_DIR;

    // Create directory if not exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const filePath = path.join(logsDir, file);
    // Secret-shaped material is scrubbed even here: an inspector trace is still a
    // diagnostic written to disk.
    fs.writeFileSync(filePath, redactString(String(content)), "utf-8");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error saving file:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
