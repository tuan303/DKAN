import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface ActionMenuItem {
  key: string;
  label: string;
  /** Tên biểu tượng Material Symbols. */
  icon?: string;
  /** Thao tác khó hoàn tác (xóa...): chữ đỏ, tách khỏi các mục trên bằng một đường kẻ. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

const ITEM_HEIGHT = 44;

/**
 * Mở lên trên khi phía dưới nút không đủ chỗ trong khung cuộn chứa nó (hoặc màn
 * hình) mà phía trên rộng hơn — menu của dòng cuối danh sách không bị khung cắt.
 */
function opensUpward(trigger: Element | null | undefined, count: number): boolean {
  if (!trigger || typeof window === 'undefined' || typeof trigger.getBoundingClientRect !== 'function') return false;
  const rect = trigger.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  for (let el = trigger.parentElement; el; el = el.parentElement) {
    const overflow = window.getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      const box = el.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
      break;
    }
  }
  const below = bottom - rect.bottom;
  return below < count * ITEM_HEIGHT + 16 && rect.top - top > below;
}

/**
 * Nút "⋯" gom các thao tác của một dòng vào một menu thả xuống. Đóng khi chọn một
 * mục, bấm ra ngoài hoặc nhấn Esc (trả focus về nút); mũi tên lên/xuống, Home/End
 * chuyển giữa các mục.
 */
export function ActionMenu({ label, items, disabled = false }: { label: string; items: ActionMenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [upward, setUpward] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Đang bận (đang lưu...) thì đóng menu: mục đã hiện có thể không còn đúng.
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  if (!items.length) return null;

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
    if (!entries.length) return;
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? entries.length - 1
        : (at + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
    entries[next].focus();
  };

  const firstDanger = items.findIndex(item => item.danger);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={event => {
          if (!open) setUpward(opensUpward(event?.currentTarget, items.length));
          setOpen(!open);
        }}
        className={`inline-flex h-11 w-11 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'border-primary/40 bg-primary-container/50 text-primary' : 'border-transparent text-on-surface-variant hover:bg-surface-container-high'
        }`}
      >
        <span className="material-symbols-outlined text-[22px]" aria-hidden="true">more_horiz</span>
        <span className="sr-only">{label}</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={moveFocus}
          className={`absolute right-0 z-30 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest py-1 shadow-lg ${
            upward ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {items.map((item, index) => (
            <div key={item.key}>
              {index === firstDanger && index > 0 && <div role="separator" className="my-1 border-t border-outline-variant" />}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { setOpen(false); item.onSelect(); }}
                className={`flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left text-body-md outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  item.danger
                    ? 'text-error hover:bg-error-container/40 focus-visible:bg-error-container/40'
                    : 'text-on-surface hover:bg-surface-container-high focus-visible:bg-surface-container-high'
                }`}
              >
                {item.icon && <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">{item.icon}</span>}
                <span className="min-w-0">{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
