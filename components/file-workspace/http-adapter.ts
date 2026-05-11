import type {
  FileWorkspaceAdapter,
  FileWorkspaceFile,
  FileWorkspaceFileWithContent
} from "@/components/file-workspace/file-workspace";

async function readPayload(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "请求失败");
  }
  return payload;
}

export function createHttpFileWorkspaceAdapter(baseUrl: string): FileWorkspaceAdapter {
  return {
    async list() {
      const response = await fetch(baseUrl, { cache: "no-store" });
      const payload = await readPayload(response);
      return (Array.isArray(payload.data) ? payload.data : []) as FileWorkspaceFile[];
    },
    async read(path: string) {
      const response = await fetch(`${baseUrl}?path=${encodeURIComponent(path)}`, { cache: "no-store" });
      const payload = await readPayload(response);
      return payload.data as FileWorkspaceFileWithContent;
    },
    async upsert(path: string, content: string) {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content })
      });
      const payload = await readPayload(response);
      return payload.data as FileWorkspaceFileWithContent;
    },
    async deleteFile(path: string) {
      const response = await fetch(baseUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
      });
      await readPayload(response);
    },
    async deleteDirectory(prefix: string) {
      const response = await fetch(baseUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix })
      });
      await readPayload(response);
    },
    async moveFile(fromPath: string, toPath: string) {
      const response = await fetch(baseUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromPath, toPath })
      });
      const payload = await readPayload(response);
      return payload.data as FileWorkspaceFile;
    }
  };
}
