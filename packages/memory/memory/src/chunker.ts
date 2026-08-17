/**
 * Markdown-aware semantic chunking for memory files.
 *
 * Chunks respect markdown structure (headers, paragraphs, code blocks) and
 * include ancestor header context for self-containment. Character counts
 * proxy for token counts; the service config owns both bounds.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { createHash } from 'node:crypto'
import type { MemoryChunk, MemoryChunkId, MemoryPath, MemoryScope } from './types.ts'

/** Chunk configuration resolved by the provider. */
export interface ChunkConfig {
  /** Maximum chunk size in characters. */
  readonly maxChunkChars: number
  /** Overlap in characters between continuation chunks. */
  readonly chunkOverlapChars: number
}

/** One extracted chunk before scope/path attribution. */
export interface ExtractedChunk {
  /** Chunk text including ancestor header context. */
  readonly text: string
  /** 0-based start line in the source file. */
  readonly startLine: number
  /** 0-based end line (exclusive) in the source file. */
  readonly endLine: number
}

/**
 * Compute a stable content hash for one chunk.
 * @param text - chunk text.
 * @returns the deterministic content hash.
 */
export function chunkHash(text: string): MemoryChunkId {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24) as MemoryChunkId
}

/**
 * Split markdown content into chunks, respecting structure.
 *
 * Strategy: split on `##` (or deeper) headers, then sub-split oversized
 * sections on paragraph boundaries, then on line boundaries. Continuation
 * chunks keep the previous chunk's tail overlap plus ancestor header context.
 * @param content - full markdown file content.
 * @param config - resolved chunk bounds.
 * @returns extracted chunks in document order.
 */
export function chunkMarkdown(content: string, config: ChunkConfig): ExtractedChunk[] {
  if (content.length === 0) return []
  if (content.length <= config.maxChunkChars) {
    return [{
      text: content,
      startLine: 0,
      endLine: lineCount(content),
    }]
  }
  const lines = content.split('\n')
  const chunks: ExtractedChunk[] = []
  const sections = splitByHeaders(lines)
  for (const section of sections) {
    const sectionText = section.lines.join('\n')
    if (sectionText.length <= config.maxChunkChars) {
      chunks.push({
        text: addHeaderContext(section.headerContext, sectionText),
        startLine: section.startLine,
        endLine: section.startLine + section.lines.length,
      })
    } else {
      chunks.push(...splitSectionByParagraphs(section, config))
    }
  }
  return chunks
}

/** One document section delimited by headers. */
interface Section {
  readonly lines: readonly string[]
  readonly startLine: number
  readonly headerContext: string
}

/** Split lines into sections by `##` (or deeper) headers. */
function splitByHeaders(lines: readonly string[]): Section[] {
  const sections: Section[] = []
  let currentLines: string[] = []
  let currentStart = 0
  const headerStack: Array<{ level: number; text: string }> = []
  for (const [index, line] of lines.entries()) {
    const level = headerLevel(line)
    if (level !== undefined) {
      if (currentLines.length > 0) {
        sections.push({
          lines: currentLines,
          startLine: currentStart,
          headerContext: formatHeaderContext(headerStack),
        })
        currentLines = []
      }
      currentStart = index
      let top = headerStack[headerStack.length - 1]
      while (top !== undefined && top.level >= level) {
        headerStack.pop()
        top = headerStack[headerStack.length - 1]
      }
      headerStack.push({ level, text: line })
    }
    currentLines.push(line)
  }
  /* v8 ignore next -- every processed line is pushed, so the trailing buffer is never empty */
  if (currentLines.length > 0) {
    sections.push({
      lines: currentLines,
      startLine: currentStart,
      headerContext: formatHeaderContext(headerStack),
    })
  }
  return sections
}

/** Split one oversized section into sub-chunks by paragraph boundaries. */
function splitSectionByParagraphs(section: Section, config: ChunkConfig): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = []
  let currentText = ''
  let currentStart = section.startLine
  let lineOffset = 0
  for (const [index, line] of section.lines.entries()) {
    const isBlank = line.trim().length === 0
    if (isBlank && currentText.length > 0 && currentText.length + line.length > config.maxChunkChars) {
      const flushed = currentText.trim()
      chunks.push({
        text: addHeaderContext(section.headerContext, flushed),
        startLine: currentStart,
        endLine: section.startLine + index,
      })
      currentText = config.chunkOverlapChars > 0
        ? tailChars(flushed, config.chunkOverlapChars)
        : ''
      currentStart = section.startLine + index + 1
      lineOffset = index + 1
      continue
    }
    if (currentText.length > 0) currentText += '\n'
    currentText += line
    if (currentText.length > config.maxChunkChars && index > lineOffset) {
      const splitAt = currentText.lastIndexOf('\n')
      const keep = splitAt < 0 ? currentText : currentText.slice(0, splitAt)
      const remainder = splitAt < 0 ? '' : currentText.slice(splitAt + 1)
      chunks.push({
        text: addHeaderContext(section.headerContext, keep.trim()),
        startLine: currentStart,
        endLine: section.startLine + index,
      })
      currentText = remainder
      currentStart = section.startLine + index
      lineOffset = index
    }
  }
  if (currentText.trim().length > 0) {
    chunks.push({
      text: addHeaderContext(section.headerContext, currentText.trim()),
      startLine: currentStart,
      endLine: section.startLine + section.lines.length,
    })
  }
  return chunks
}

/**
 * Detect markdown header level; returns `undefined` for non-header lines.
 * @param line - one source line.
 * @returns the header level, or `undefined` when the line is not a header.
 */
export function headerLevel(line: string): number | undefined {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('#')) return undefined
  let level = 0
  for (const char of trimmed) {
    if (char !== '#') break
    level += 1
  }
  const rest = trimmed.slice(level)
  if (rest.length === 0 || rest.startsWith(' ')) return level
  return undefined
}

/** Render the active header stack as `A > B > C` context. */
function formatHeaderContext(stack: readonly { level: number; text: string }[]): string {
  return stack.map(entry => entry.text.trim()).join(' > ')
}

/** Prepend ancestor header context to a chunk body. */
function addHeaderContext(context: string, body: string): string {
  return context.length === 0 ? body : `${context}\n${body}`
}

/** Return the last `count` characters of a string. */
function tailChars(text: string, count: number): string {
  const chars = Array.from(text)
  return chars.slice(Math.max(0, chars.length - count)).join('')
}

/** Count line boundaries in content; empty content has zero lines. */
function lineCount(content: string): number {
  /* v8 ignore next -- chunkMarkdown returns early on empty content before reaching here */
  if (content.length === 0) return 0
  return content.split('\n').length
}

/** Build a full chunk record with attribution for one extracted chunk.
 * @param extracted - the chunk content and line bounds.
 * @param path - owning memory file path.
 * @param source - owning scope.
 * @param createdAt - creation epoch millisecond.
 * @returns the attributed chunk record.
 */
export function attributeChunk(
  extracted: ExtractedChunk,
  path: MemoryPath,
  source: MemoryScope,
  createdAt: number,
): MemoryChunk {
  return {
    id: chunkHash(extracted.text),
    path,
    startLine: extracted.startLine,
    endLine: extracted.endLine,
    text: extracted.text,
    source,
    accessCount: 0,
    createdAt,
  }
}
