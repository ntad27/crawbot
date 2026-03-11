/**
 * FileViewer — renders non-text files inline:
 * - Images: <img> tag
 * - PDF: <iframe> with Chromium's built-in PDF viewer
 * - Audio: <audio> player
 * - Video: <video> player
 * - Office documents: converted HTML (mammoth for docx, SheetJS for xlsx, XML parse for pptx)
 *   with fallback to "Open in Default App" for unsupported legacy formats.
 */
import React, { useState } from 'react';
import {
  Image,
  FileAudio,
  FileVideo,
  FileSpreadsheet,
  Presentation,
  FileText,
  ExternalLink,
  X,
  File,
} from 'lucide-react';
import { useFileBrowserStore, type OfficeConvertResult } from '@/stores/file-browser';
import { getFileTypeLabel } from '@/utils/file-type';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FileViewMode } from '@/utils/file-type';

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getFileIcon(viewMode: FileViewMode) {
  switch (viewMode) {
    case 'image': return Image;
    case 'audio': return FileAudio;
    case 'video': return FileVideo;
    case 'office': return File;
    default: return FileText;
  }
}

function getOfficeIcon(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['ppt', 'pptx', 'odp'].includes(ext)) return Presentation;
  return FileText;
}

/* ─── Inline sub-viewers ─── */

function ImageViewer({ url, fileName }: { url: string; fileName: string }) {
  return (
    <div className="flex-1 flex items-center justify-center p-4 overflow-auto bg-muted/20">
      <img
        src={url}
        alt={fileName}
        className="max-w-full max-h-full object-contain rounded shadow-sm"
        draggable={false}
      />
    </div>
  );
}

function PdfViewer({ url }: { url: string }) {
  return (
    <div className="flex-1 overflow-hidden">
      <iframe
        src={url}
        className="w-full h-full border-0"
        title="PDF Preview"
      />
    </div>
  );
}

function AudioPlayer({ url, fileName }: { url: string; fileName: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
      <FileAudio className="h-16 w-16 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">{fileName}</p>
      <audio
        controls
        className="w-full max-w-md"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        src={url}
      >
        Your browser does not support the audio element.
      </audio>
    </div>
  );
}

function VideoPlayer({ url, fileName }: { url: string; fileName: string }) {
  return (
    <div className="flex-1 flex flex-col p-4 bg-black/5 min-h-0">
      <video
        controls
        className="w-full flex-1 min-h-0 rounded object-contain"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        src={url}
        title={fileName}
      >
        Your browser does not support the video element.
      </video>
    </div>
  );
}

/* ─── Office sub-viewers ─── */

/** Rendered HTML document (Word .docx) */
function DocumentViewer({ html }: { html: string }) {
  return (
    <div className="flex-1 overflow-auto p-4 bg-white dark:bg-zinc-900">
      <div
        className="prose prose-sm dark:prose-invert max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** Rendered spreadsheet with sheet tabs */
function SpreadsheetViewer({ sheets }: { sheets: { name: string; html: string }[] }) {
  const [activeSheet, setActiveSheet] = useState(0);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-muted/20 overflow-x-auto shrink-0">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActiveSheet(i)}
              className={cn(
                'px-2 py-0.5 text-[11px] rounded-sm whitespace-nowrap transition-colors',
                i === activeSheet
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {/* Sheet content */}
      <div className="flex-1 overflow-auto">
        <div
          className={cn(
            '[&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
            '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
            '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/40 [&_th]:font-medium [&_th]:text-left',
            '[&_tr:hover]:bg-muted/20',
          )}
          dangerouslySetInnerHTML={{ __html: sheets[activeSheet]?.html ?? '' }}
        />
      </div>
    </div>
  );
}

/** Rendered presentation slides (text extracted from PPTX) */
function PresentationViewer({ slides }: { slides: { index: number; text: string }[] }) {
  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {slides.map((slide) => (
        <div
          key={slide.index}
          className="border border-border rounded-lg p-4 bg-white dark:bg-zinc-900"
        >
          <div className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wider">
            Slide {slide.index}
          </div>
          <div className="text-sm whitespace-pre-wrap">
            {slide.text || <span className="text-muted-foreground italic">(empty slide)</span>}
          </div>
        </div>
      ))}
      {slides.length === 0 && (
        <p className="text-sm text-muted-foreground text-center">No slide content found.</p>
      )}
    </div>
  );
}

/** Rendered presentation slides (HTML from pptx-to-html — images, shapes, formatting) */
function PresentationHtmlViewer({
  slidesHtml,
  slideWidth,
  slideHeight,
}: {
  slidesHtml: string[];
  slideWidth: number;
  slideHeight: number;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width - 32); // 32px for padding
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale = containerWidth > 0 ? Math.min(containerWidth / slideWidth, 1) : 0;

  return (
    <div ref={containerRef} className="flex-1 overflow-auto p-4 space-y-4 bg-muted/20">
      {slidesHtml.map((html, i) => (
        <div
          key={i}
          className="border border-border rounded-lg overflow-hidden bg-white dark:bg-zinc-900 shadow-sm"
        >
          <div className="text-[10px] text-muted-foreground px-3 py-1 border-b border-border bg-muted/30 uppercase tracking-wider">
            Slide {i + 1}
          </div>
          <div
            style={{
              width: slideWidth * scale,
              height: slideHeight * scale,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                width: slideWidth,
                height: slideHeight,
              }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      ))}
      {slidesHtml.length === 0 && (
        <p className="text-sm text-muted-foreground text-center">No slide content found.</p>
      )}
    </div>
  );
}

/** Fallback for unsupported office format or conversion error */
function OfficeErrorFallback({ filePath, error }: { filePath: string; error: string }) {
  const openFileExternal = useFileBrowserStore((s) => s.openFileExternal);
  const fileName = getFileName(filePath);
  const typeLabel = getFileTypeLabel(filePath);
  const officeIconElement = React.createElement(getOfficeIcon(filePath), { className: 'h-16 w-16 text-muted-foreground/30' });

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
      {officeIconElement}
      <p className="text-sm font-medium text-foreground">{fileName}</p>
      <p className="text-xs text-muted-foreground">{typeLabel}</p>
      <p className="text-xs text-muted-foreground/70 max-w-[250px] text-center">{error}</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 gap-1.5"
        onClick={() => openFileExternal(filePath)}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in Default App
      </Button>
    </div>
  );
}

/** Render the correct office sub-viewer based on converted data */
function OfficeViewer({ data, filePath }: { data: OfficeConvertResult; filePath: string }) {
  switch (data.format) {
    case 'document':
      return <DocumentViewer html={data.html} />;
    case 'spreadsheet':
      return <SpreadsheetViewer sheets={data.sheets} />;
    case 'presentation':
      return <PresentationViewer slides={data.slides} />;
    case 'presentation-html':
      return (
        <PresentationHtmlViewer
          slidesHtml={data.slidesHtml}
          slideWidth={data.slideWidth}
          slideHeight={data.slideHeight}
        />
      );
    case 'presentation-pdf':
      return <PdfViewer url={data.url} />;
    case 'error':
      return <OfficeErrorFallback filePath={filePath} error={data.error} />;
  }
}

/* ─── Main FileViewer ─── */

export function FileViewer() {
  const selectedFile = useFileBrowserStore((s) => s.selectedFile);
  const fileViewMode = useFileBrowserStore((s) => s.fileViewMode);
  const fileUrl = useFileBrowserStore((s) => s.fileUrl);
  const fileSize = useFileBrowserStore((s) => s.fileSize);
  const fileOfficeData = useFileBrowserStore((s) => s.fileOfficeData);
  const fileLoading = useFileBrowserStore((s) => s.fileLoading);
  const closeFile = useFileBrowserStore((s) => s.closeFile);
  const openFileExternal = useFileBrowserStore((s) => s.openFileExternal);

  if (!selectedFile || !fileViewMode) return null;

  const fileName = getFileName(selectedFile);
  const typeLabel = getFileTypeLabel(selectedFile);

  const iconComponent = fileViewMode === 'office' ? getOfficeIcon(selectedFile) : getFileIcon(fileViewMode);

  if (fileLoading) {
    return (
      <div className="flex flex-col h-full">
        <ViewerTabBar
          fileName={fileName}
          typeLabel={typeLabel}
          Icon={iconComponent}
          fileSize={fileSize}
          onClose={closeFile}
          onOpenExternal={() => openFileExternal()}
        />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <ViewerTabBar
        fileName={fileName}
        typeLabel={typeLabel}
        Icon={iconComponent}
        fileSize={fileSize}
        onClose={closeFile}
        onOpenExternal={() => openFileExternal()}
      />
      {fileViewMode === 'image' && fileUrl && (
        <ImageViewer url={fileUrl} fileName={fileName} />
      )}
      {fileViewMode === 'pdf' && fileUrl && (
        <PdfViewer url={fileUrl} />
      )}
      {fileViewMode === 'audio' && fileUrl && (
        <AudioPlayer url={fileUrl} fileName={fileName} />
      )}
      {fileViewMode === 'video' && fileUrl && (
        <VideoPlayer url={fileUrl} fileName={fileName} />
      )}
      {fileViewMode === 'office' && fileOfficeData && (
        <OfficeViewer data={fileOfficeData} filePath={selectedFile} />
      )}
      {/* Fallback: data failed to load for media types */}
      {fileViewMode !== 'office' && !fileUrl && !fileLoading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-muted-foreground">
          {React.createElement(iconComponent, { className: 'h-12 w-12 opacity-30' })}
          <p className="text-xs">Failed to load preview</p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => openFileExternal()}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in Default App
          </Button>
        </div>
      )}
    </div>
  );
}

/* ─── Shared tab bar ─── */

function ViewerTabBar({
  fileName,
  typeLabel,
  Icon,
  fileSize,
  onClose,
  onOpenExternal,
}: {
  fileName: string;
  typeLabel: string;
  Icon: React.ComponentType<{ className?: string }>;
  fileSize: number | null;
  onClose: () => void;
  onOpenExternal: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0 bg-muted/30">
      <div className="flex items-center gap-1.5 min-w-0">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs truncate max-w-[140px]">{fileName}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">{typeLabel}</span>
        {fileSize != null && (
          <span className="text-[10px] text-muted-foreground/60 shrink-0">
            ({formatFileSize(fileSize)})
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onOpenExternal}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>Open in default app</p></TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>Close</p></TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
