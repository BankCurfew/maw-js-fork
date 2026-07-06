import { useState, useRef, useCallback, useMemo } from "react";
import { apiUrl } from "../lib/api";

export interface Attachment {
  id: string;
  url: string;
  localUrl: string;
  name: string;
  size: number;
  mimeType: string;
}

export function useFileAttach() {
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (file: File): Promise<Attachment | null> => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(apiUrl("/api/attach"), { method: "POST", body: form });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Upload failed");
      const att: Attachment = { id: data.id, url: data.url, localUrl: data.localUrl, name: data.name, size: data.size, mimeType: data.mimeType };
      setAttachments((prev) => [...prev, att]);
      return att;
    } catch (e) {
      console.error("Upload failed:", e);
      return null;
    } finally {
      setUploading(false);
    }
  }, []);

  const pickFile = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      await upload(file);
    }
    if (inputRef.current) inputRef.current.value = "";
  }, [upload]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  /** Build text with attachment URLs appended */
  const buildMessage = useCallback((text: string): string => {
    if (attachments.length === 0) return text;
    const urls = attachments.map((a) => a.localUrl);
    const suffix = urls.length === 1
      ? `\n[attached: ${attachments[0].name}] ${urls[0]}`
      : `\n[${attachments.length} files attached]\n${attachments.map((a, i) => `- ${a.name}: ${urls[i]}`).join("\n")}`;
    return text ? text + suffix : suffix.trim();
  }, [attachments]);

  /** Handle paste — extracts files (images from clipboard) */
  const onPaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          // Give clipboard images a better name
          const name = file.name === "image.png" || file.name === "blob"
            ? `clipboard-${Date.now()}.${file.type.split("/")[1] || "png"}`
            : file.name;
          const renamed = new File([file], name, { type: file.type });
          await upload(renamed);
        }
      }
    }
  }, [upload]);

  /** Drag & drop handlers — spread on a container */
  const drag = useMemo(() => {
    let dragCounter = 0;
    return {
      onDragEnter: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        (e.currentTarget as HTMLElement).dataset.dragOver = "true";
      },
      onDragLeave: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          delete (e.currentTarget as HTMLElement).dataset.dragOver;
        }
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
      },
      onDrop: async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        delete (e.currentTarget as HTMLElement).dataset.dragOver;
        const files = e.dataTransfer.files;
        for (const file of Array.from(files)) {
          await upload(file);
        }
      },
    };
  }, [upload]);

  // Keep old API for backward compat
  const dragHandlers = useCallback(() => drag, [drag]);

  return {
    uploading,
    attachments,
    inputRef,
    pickFile,
    onFileChange,
    removeAttachment,
    clearAttachments,
    buildMessage,
    dragHandlers,
    drag,
    onPaste,
    upload,
  };
}

/** Tiny component for the hidden file input */
export function FileInput({ inputRef, onChange }: { inputRef: React.RefObject<HTMLInputElement | null>; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept="image/*,application/pdf,.txt,.md,.json,.csv,.log,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.sh,.sql,.zip,.tar.gz"
      capture={undefined}
      onChange={onChange}
      className="hidden"
    />
  );
}

/** Attachment preview chips */
export function AttachmentChips({ attachments, onRemove, uploading }: { attachments: Attachment[]; onRemove: (id: string) => void; uploading: boolean }) {
  if (attachments.length === 0 && !uploading) return null;
  return (
    <div className="flex flex-wrap gap-1.5 py-1 px-1">
      {attachments.map((a) => {
        const isImage = a.mimeType.startsWith("image/");
        return (
          <div key={a.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px]"
            style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)" }}>
            {isImage && (
              <img src={a.url} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
            )}
            {!isImage && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-400 flex-shrink-0">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" />
              </svg>
            )}
            <span className="text-cyan-400 truncate max-w-[120px]">{a.name}</span>
            <span className="text-white/30 text-[9px]">{formatSize(a.size)}</span>
            <button onClick={() => onRemove(a.id)} className="text-white/40 hover:text-red-400 ml-0.5 text-xs leading-none cursor-pointer">&times;</button>
          </div>
        );
      })}
      {uploading && (
        <div className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-cyan-400/60"
          style={{ background: "rgba(34,211,238,0.05)" }}>
          <span className="animate-pulse">uploading...</span>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
