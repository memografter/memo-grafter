import type { Message } from "../core/types.js";

export function renderInvocationRequestPlainText(request: { system: string; messages: Message[] }): string {
  const sections: string[] = [
    "=== FRAMEWORK SYSTEM ===\n" + (request.system || "(empty)"),
  ];
  request.messages.forEach((message, index) => {
    sections.push(`=== MESSAGE ${index + 1} · ${message.role.toUpperCase()} ===\n${message.content}`);
  });
  return sections.join("\n\n");
}
