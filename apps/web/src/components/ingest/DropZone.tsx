'use client';

import { useCallback, useRef, useState } from 'react';
import { FileUp, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { formatFromFilename } from '@/lib/engine/types';
import { cn } from '@/lib/utils/cn';

const ACCEPT = '.csv,.tsv,.txt,.json,.ndjson,.parquet,.pq,.xlsx,.xls';

interface Props {
  onFiles: (files: File[]) => void;
  /** Compact variant for when data is already loaded. */
  compact?: boolean;
}

export function DropZone({ onFiles, compact = false }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Drag events fire for every child element; count them so leaving a child
  // doesn't clear the highlight while the pointer is still over the zone.
  const dragDepth = useRef(0);

  const accept = useCallback((list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;

    const supported: File[] = [];
    for (const file of files) {
      if (formatFromFilename(file.name)) supported.push(file);
      else toast.error(`${file.name}: unsupported file type`);
    }
    if (supported.length > 0) onFiles(supported);
  }, [onFiles]);

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        accept(event.dataTransfer.files);
      }}
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors',
        compact ? 'gap-1 p-4' : 'gap-3 p-12',
        dragging
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
          : 'border-[var(--color-border)]',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => {
          accept(event.target.files);
          // Reset so re-picking the same file fires change again.
          event.target.value = '';
        }}
      />

      {compact ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
        >
          <FileUp className="size-4" />
          Add another file
        </button>
      ) : (
        <>
          <Upload
            className={cn(
              'size-8',
              dragging ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-muted)]',
            )}
          />
          <div className="text-center">
            <p className="text-sm font-medium">Drop a data file here</p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              CSV, TSV, JSON, Parquet or Excel — parsed in your browser, never uploaded
            </p>
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-ink)] hover:opacity-90"
          >
            Choose a file
          </button>
        </>
      )}
    </div>
  );
}
