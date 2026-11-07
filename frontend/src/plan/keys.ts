export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean; type?: string } | null;
}

export class PlanKeys {
  static typing(target: KeyInput["target"]): boolean {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const type = (target.type ?? "text").toLowerCase();
      return ["text", "search", "email", "url", "password", "tel", "number", "time", "date", "datetime-local"].includes(type);
    }
    return Boolean(target.isContentEditable);
  }

  static command(event: KeyInput): string | null {
    if (event.key === "Escape") return "escape";
    if (PlanKeys.typing(event.target ?? null)) return null;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
      return "undo";
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return null;
    switch (event.key) {
      case "t":
      case "T":
        return "today";
      case "w":
      case "W":
        return "week";
      case "d":
      case "D":
        return "day";
      case "n":
      case "N":
        return "quick-add";
      case "/":
        return "find";
      case "a":
      case "A":
        return "approve";
      case "x":
      case "X":
        return "deny";
      case " ":
        return "toggle-done";
      case "ArrowLeft":
        return "arrow-left";
      case "ArrowRight":
        return "arrow-right";
      case "ArrowUp":
        return "arrow-up";
      case "ArrowDown":
        return "arrow-down";
      default:
        return null;
    }
  }
}

export class PlanFocus {
  static ids(): { blockId: string | null; proposalId: string | null } {
    const element = document.activeElement;
    if (!(element instanceof Element)) return { blockId: null, proposalId: null };
    return {
      blockId: element.closest("[data-block-id]")?.getAttribute("data-block-id") ?? null,
      proposalId: element.closest("[data-proposal-id]")?.getAttribute("data-proposal-id") ?? null,
    };
  }
}
