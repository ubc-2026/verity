import { evaluate, parse, traverse, type ObjectNode } from "@humanwhocodes/momoa";

export class StrictJsonError extends Error {
  override name = "StrictJsonError";
}

/**
 * Parses JSON text and rejects any object that repeats a key.
 *
 * `JSON.parse` keeps the last duplicate silently, which would let two parties
 * disagree about which value was committed. Momoa exposes every member, so a
 * duplicate is detected before evaluation.
 */
export function parseStrictJson(text: string): unknown {
  let document;
  try {
    document = parse(text, { mode: "json" });
  } catch (error) {
    throw new StrictJsonError(`invalid JSON: ${(error as Error).message}`);
  }

  traverse(document, {
    enter(node) {
      if (node.type !== "Object") return;
      const seen = new Set<string>();
      for (const member of (node as ObjectNode).members) {
        const key = member.name.type === "String" ? member.name.value : member.name.name;
        if (seen.has(key)) {
          throw new StrictJsonError(`duplicate JSON key: ${JSON.stringify(key)}`);
        }
        seen.add(key);
      }
    },
  });

  return evaluate(document.body);
}
