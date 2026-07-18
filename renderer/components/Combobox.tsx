/*
 * 可搜索下拉（#9）——严格按 mockups/01 的 combo/dropdown 结构与状态：
 * 输入即本地模糊过滤、↑↓ 循环、回车确认、Esc 关闭、末尾固定「未定」项（可选）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TermItem } from '../../common/types.ts';
import { displayValue, filterOptions, moveActive } from '../lib/combobox.ts';

export interface ComboboxProps {
  options: TermItem[];
  placeholder: string;
  metaText: string;
  selected: TermItem | 'undecided' | null;
  onSelect(next: TermItem | 'undecided' | null): void;
  /** 提供时在列表末尾固定「未定」项（院校字段） */
  undecidedLabel?: string;
  icon?: string;
}

export function Combobox(props: ComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterOptions(props.options, query), [props.options, query]);
  const rowCount = filtered.length + (props.undecidedLabel ? 1 : 0);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const commit = (index: number): void => {
    if (props.undecidedLabel && index === filtered.length) {
      props.onSelect('undecided');
    } else if (index >= 0 && index < filtered.length) {
      props.onSelect(filtered[index].option);
    }
    setOpen(false);
    setQuery('');
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((cur) => moveActive(cur, e.key === 'ArrowDown' ? 1 : -1, rowCount));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0) commit(active);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  };

  const inputValue = open ? query : displayValue(props.selected, props.undecidedLabel ?? '未定');

  return (
    <div className={`combo${open ? ' open' : ''}`} ref={rootRef}>
      <svg className="search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 L14 14" />
      </svg>
      <input
        className="input"
        type="text"
        value={inputValue}
        placeholder={props.placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      <span className="chevron">▾</span>
      {open && (
        <div className="dropdown" role="listbox">
          <div className="dd-meta">
            <span>{props.metaText}</span>
            <span>{filtered.length} 项匹配</span>
          </div>
          <div className="dd-scroll">
            {filtered.map((f, i) => (
              <div
                key={f.option.value + f.option.key}
                className={`dd-item${i === active ? ' active' : ''}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(i);
                }}
              >
                {props.icon && <span className="flag">{props.icon}</span>}
                <span>
                  {f.segments.map((s, j) => (s.hit ? <mark key={j}>{s.text}</mark> : <span key={j}>{s.text}</span>))}
                </span>
                <span className="code">{f.option.value}</span>
              </div>
            ))}
            {props.undecidedLabel && (
              <div
                className={`dd-item dd-undecided${active === filtered.length ? ' active' : ''}`}
                role="option"
                aria-selected={active === filtered.length}
                onMouseEnter={() => setActive(filtered.length)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(filtered.length);
                }}
              >
                <span className="flag">◌</span>
                <span>{props.undecidedLabel}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
