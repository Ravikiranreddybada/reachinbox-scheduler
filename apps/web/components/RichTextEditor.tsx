'use client';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
  AlignCenter,
  AlignLeft,
  Bold,
  ChevronsUpDown,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { useDismiss } from './useDismiss';

export type EditorHandle = { focus: () => void };

const SIZES = [
  { label: 'Small', value: '2' },
  { label: 'Normal', value: '3' },
  { label: 'Large', value: '5' },
  { label: 'Huge', value: '6' },
];
const ALIGNS = [
  { label: 'Align left', cmd: 'justifyLeft' },
  { label: 'Center', cmd: 'justifyCenter' },
  { label: 'Align right', cmd: 'justifyRight' },
  { label: 'Justify', cmd: 'justifyFull' },
];

/**
 * Chrome turns "indent" into <blockquote style="margin:0 0 0 40px">, which would
 * collide with the real quote button. Rewrite those into plain indented divs.
 */
function normalizeIndents(root: HTMLElement) {
  root.querySelectorAll('blockquote[style*="margin"]').forEach((node) => {
    const div = document.createElement('div');
    div.style.marginLeft = '40px';
    while (node.firstChild) div.appendChild(node.firstChild);
    node.replaceWith(div);
  });
}

/** Rich-text editor on contentEditable, with the exact toolbar from the design. */
export function RichTextEditor({
  onChange,
  editorRef,
}: {
  onChange: (html: string, text: string) => void;
  editorRef?: Ref<EditorHandle>;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);
  const [active, setActive] = useState({
    bold: false,
    italic: false,
    underline: false,
    strike: false,
  });
  const [menu, setMenu] = useState<'size' | 'align' | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useDismiss(toolbar, menu !== null, () => setMenu(null));
  useImperativeHandle(editorRef, () => ({ focus: () => area.current?.focus() }));

  const emit = useCallback(() => {
    const node = area.current;
    if (!node) return;
    normalizeIndents(node);
    const text = node.innerText.replace(/​/g, '').trim();
    setEmpty(!text && !node.querySelector('img,ul,ol,hr'));
    onChange(text ? node.innerHTML : '', text);
  }, [onChange]);

  const syncState = useCallback(() => {
    if (!area.current?.contains(document.getSelection()?.anchorNode ?? null)) return;
    setActive({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      strike: document.queryCommandState('strikeThrough'),
    });
  }, []);
  useEffect(() => {
    document.addEventListener('selectionchange', syncState);
    return () => document.removeEventListener('selectionchange', syncState);
  }, [syncState]);

  function run(command: string, value?: string) {
    area.current?.focus();
    document.execCommand(command, false, value);
    emit();
    syncState();
  }
  // Keep the text selection while a toolbar button is pressed.
  const keep = (event: React.MouseEvent) => event.preventDefault();

  function Btn({
    label,
    icon,
    command,
    value,
    pressed,
  }: {
    label: string;
    icon: React.ReactNode;
    command: string;
    value?: string;
    pressed?: boolean;
  }) {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={pressed}
        onMouseDown={keep}
        onClick={() => run(command, value)}
      >
        {icon}
      </button>
    );
  }
  const s = 19;

  return (
    <div
      className="editor-box"
      onMouseDown={(e) => e.target === e.currentTarget && area.current?.focus()}
    >
      {empty && <span className="editor-placeholder">Type Your Reply...</span>}
      <div className="rte-toolbar" role="toolbar" aria-label="Formatting" ref={toolbar}>
        <Btn label="Undo" command="undo" icon={<Undo2 size={s} strokeWidth={1.5} />} />
        <Btn label="Redo" command="redo" icon={<Redo2 size={s} strokeWidth={1.5} />} />
        <span className="sep" />
        <span className="menu-wrap">
          <button
            type="button"
            className="wide"
            aria-label="Font size"
            title="Font size"
            aria-haspopup="menu"
            aria-expanded={menu === 'size'}
            onMouseDown={keep}
            onClick={() => setMenu(menu === 'size' ? null : 'size')}
          >
            <Type size={s} strokeWidth={1.5} />
            <ChevronsUpDown size={11} />
          </button>
          {menu === 'size' && (
            <div className="menu" role="menu">
              {SIZES.map((size) => (
                <button
                  key={size.value}
                  role="menuitem"
                  onMouseDown={keep}
                  onClick={() => {
                    run('fontSize', size.value);
                    setMenu(null);
                  }}
                >
                  {size.label}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className="sep" />
        <Btn
          label="Bold"
          command="bold"
          pressed={active.bold}
          icon={<Bold size={s} strokeWidth={2} />}
        />
        <Btn
          label="Italic"
          command="italic"
          pressed={active.italic}
          icon={<Italic size={s} strokeWidth={1.5} />}
        />
        <Btn
          label="Underline"
          command="underline"
          pressed={active.underline}
          icon={<Underline size={s} strokeWidth={1.5} />}
        />
        <span className="sep" />
        <Btn
          label="Align center"
          command="justifyCenter"
          icon={<AlignCenter size={s} strokeWidth={1.5} />}
        />
        <span className="menu-wrap">
          <button
            type="button"
            aria-label="More alignment options"
            title="Alignment"
            aria-haspopup="menu"
            aria-expanded={menu === 'align'}
            onMouseDown={keep}
            onClick={() => setMenu(menu === 'align' ? null : 'align')}
          >
            <ChevronsUpDown size={s} strokeWidth={1.5} />
          </button>
          {menu === 'align' && (
            <div className="menu" role="menu">
              {ALIGNS.map((align) => (
                <button
                  key={align.cmd}
                  role="menuitem"
                  onMouseDown={keep}
                  onClick={() => {
                    run(align.cmd);
                    setMenu(null);
                  }}
                >
                  {align.label}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className="sep" />
        <Btn
          label="Numbered list"
          command="insertOrderedList"
          icon={<ListOrdered size={s} strokeWidth={1.5} />}
        />
        <Btn
          label="Bulleted list"
          command="insertUnorderedList"
          icon={<List size={s} strokeWidth={1.5} />}
        />
        <Btn
          label="Increase indent"
          command="indent"
          icon={<IndentIncrease size={s} strokeWidth={1.5} />}
        />
        <Btn
          label="Decrease indent"
          command="outdent"
          icon={<IndentDecrease size={s} strokeWidth={1.5} />}
        />
        <Btn
          label="Quote"
          command="formatBlock"
          value="blockquote"
          icon={<Quote size={s} strokeWidth={1.5} fill="currentColor" />}
        />
        <Btn
          label="Align left"
          command="justifyLeft"
          icon={<AlignLeft size={s} strokeWidth={1.5} />}
        />
        <span className="sep" />
        <Btn
          label="Strikethrough"
          command="strikeThrough"
          pressed={active.strike}
          icon={<Strikethrough size={s} strokeWidth={1.5} />}
        />
        <Btn
          label="Clear formatting"
          command="removeFormat"
          icon={<RemoveFormatting size={s} strokeWidth={1.5} />}
        />
      </div>
      <div
        ref={area}
        className="editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message body"
        onInput={emit}
        onBlur={emit}
        onPaste={(event) => {
          // Paste as plain text: no foreign styles or markup enter the message.
          event.preventDefault();
          document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
        }}
      />
    </div>
  );
}
