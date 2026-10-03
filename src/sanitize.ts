export function sanitizeVkPlainText(text: string): string {
  return (
    text
      .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, "$1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(p|div)>/gi, "\n")
      .replace(/<(b|strong)>(.*?)<\/\1>/gi, "*$2*")
      .replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_")
      .replace(/<(s|strike|del)>(.*?)<\/\1>/gi, "~$2~")
      .replace(/<code>(.*?)<\/code>/gi, "`$1`")
      .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n*$1*\n")
      .replace(/<li[^>]*>(.*?)<\/li>/gi, "• $1\n")
      .replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
  );
}
