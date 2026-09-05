export interface SessionChoice {
  readonly session: { readonly installationId: string; readonly opaqueId: string };
  readonly availability: string;
  readonly title?: string;
  readonly cwd?: string;
}

export async function pickSession(
  sessions: readonly SessionChoice[],
  ask: (prompt: string) => Promise<string>,
) {
  if (!sessions.length) throw new Error("No Codex sessions found");
  const choices = sessions
      .map(
        (session, index) =>
          `${index + 1}) ${session.title ?? "Untitled session"} [${session.availability}]${session.cwd ? ` ${session.cwd}` : ""}`,
      )
      .join("\n"),
    answer = (await ask(`${choices}\nSelect a Codex session [1-${sessions.length}]: `)).trim();
  if (!/^\d+$/.test(answer)) throw new Error("Invalid session selection");
  const choice = Number(answer);
  if (choice < 1) throw new Error("Invalid session selection");
  const selected = sessions.at(choice - 1);
  if (!selected) throw new Error("Invalid session selection");
  return selected.session;
}
