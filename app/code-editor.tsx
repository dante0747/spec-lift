"use client";

import {
  type KeyboardEvent,
  type UIEvent,
  useDeferredValue,
  useMemo,
  useRef,
} from "react";
import { highlight } from "./highlight";
import type { SpecFormat } from "./spec-format";

function lineNumbers(value: string) {
  const count = value ? value.split("\n").length : 1;
  let text = "";
  for (let line = 1; line <= count; line += 1) {
    text += line === count ? `${line}` : `${line}\n`;
  }
  return text;
}

type GutterProps = {
  value: string;
  errorLine?: number;
  innerRef: React.RefObject<HTMLDivElement | null>;
};

function Gutter({ value, errorLine, innerRef }: GutterProps) {
  const numbers = useMemo(() => lineNumbers(value), [value]);
  return (
    <div className="code-gutter" aria-hidden="true">
      <div className="code-gutter-inner" ref={innerRef}>
        {errorLine ? (
          <span
            className="code-error-line"
            style={{ "--line": errorLine } as React.CSSProperties}
          />
        ) : null}
        {numbers}
      </div>
    </div>
  );
}

type CodeEditorProps = {
  id: string;
  value: string;
  format: SpecFormat;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  describedBy?: string;
  invalid?: boolean;
  errorLine?: number;
};

export function CodeEditor({
  id,
  value,
  format,
  onChange,
  onKeyDown,
  placeholder,
  describedBy,
  invalid,
  errorLine,
}: CodeEditorProps) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const deferredValue = useDeferredValue(value);
  // Small documents highlight on every keystroke; large ones catch up in the
  // background and show plain text while the highlight is stale.
  const source = value.length < 60_000 ? value : deferredValue;
  const stale = source !== value;
  const html = useMemo(() => highlight(source, format), [source, format]);

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
  }

  return (
    <div className="code">
      <Gutter value={value} errorLine={errorLine} innerRef={gutterRef} />
      <div className="code-body">
        <pre className="code-highlight" ref={highlightRef} aria-hidden="true">
          <code
            // Highlighted HTML is generated from escaped text in highlight.ts.
            dangerouslySetInnerHTML={{
              __html: stale ? "" : `${html}\n`,
            }}
          />
        </pre>
        <textarea
          id={id}
          className={`code-input ${stale ? "is-plain" : ""}`}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          aria-describedby={describedBy}
          aria-invalid={invalid}
        />
      </div>
    </div>
  );
}

type CodeViewProps = {
  value: string;
  format: SpecFormat;
  label: string;
  placeholder: string;
};

export function CodeView({ value, format, label, placeholder }: CodeViewProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => highlight(value, format), [value, format]);

  return (
    <div className="code is-readonly">
      <Gutter value={value} innerRef={gutterRef} />
      <pre
        className="code-view"
        tabIndex={0}
        aria-label={label}
        onScroll={(event) => {
          if (gutterRef.current) {
            gutterRef.current.style.transform = `translateY(${-event
              .currentTarget.scrollTop}px)`;
          }
        }}
      >
        {value ? (
          <code dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code className="code-placeholder">{placeholder}</code>
        )}
      </pre>
    </div>
  );
}
