// The sidebar's utility rows, folded behind one chevron.
//
// Team map, Teach a skill, Tasks & routines and Connected apps are places you
// visit occasionally; they were costing four permanent rows at the bottom of a
// list whose whole job is showing bots. They now live in a menu that opens on
// hover from a chevron beside your name.
//
// Hover alone would make them unreachable by keyboard and fragile with a
// trackpad, so: hovering opens it, a click pins it, Escape and an outside
// click close it, and the trigger is an ordinary focusable button.
import { useEffect, useId, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "@/lib/cn";

export interface MoreMenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  /** the item wants attention (a failed routine); folded items cannot show
   * their own dot, so the trigger carries one on their behalf */
  attention?: boolean;
  onSelect: () => void;
}

/** Opening is quick enough to feel like a hover, closing is slow enough to
 * forgive a diagonal path from the chevron to the menu. */
const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 250;

export function SidebarMoreMenu({ items, compact = false }: { items: MoreMenuItem[]; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const hoverOpen = () => {
    if (pinned) return;
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const hoverClose = () => {
    if (pinned) return;
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const close = () => {
    clearTimers();
    setPinned(false);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const attention = items.some((item) => item.attention);

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerEnter={hoverOpen}
      onPointerLeave={hoverClose}
      // a keyboard user tabbing in gets the same menu a pointer gets
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (pinned) return;
        if (!event.relatedTarget || !rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="More"
        title="More"
        onClick={() => {
          clearTimers();
          if (open && pinned) close();
          else {
            setPinned(true);
            setOpen(true);
          }
        }}
        className={cn(
          "relative flex items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink",
          compact ? "size-8" : "size-10",
          open && "bg-raised text-ink",
        )}
      >
        <ChevronUp size={18} className={cn("transition-transform", open && "rotate-180")} />
        {attention && !open && (
          <span className="absolute right-1.5 top-1.5 size-2 rounded-full border border-panel bg-danger" />
        )}
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="More"
          className="animate-pop-in absolute bottom-full left-1/2 z-40 mb-1 w-[196px] -translate-x-1/2 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/50"
        >
          {items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              onClick={() => {
                item.onSelect();
                close();
              }}
              className={cn(
                "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
                item.active ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className={cn("flex size-5 items-center justify-center", item.active ? "text-accent" : "text-ink-secondary")}>
                {item.icon}
              </span>
              <span className="flex-1">{item.label}</span>
              {item.attention && <span className="size-2 rounded-full bg-danger" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
