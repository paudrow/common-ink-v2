// Daily notes, a built-in extension: a note for each day, Journal/2026-10-05. Open today's note (made
// with just its date as its title if it isn't there), or the nearest day's before or after the one
// you're on. Other extensions ask it where daily notes are (its API), so there's one definition:
// quick-add puts tasks in today's note, and ticking a repeating task logs it there.
import type { FilePath } from "../../../../worker/src/files.ts";
import type { ExtensionContext, ExtensionModule } from "../../extension-api.ts";
import { dailyPath, dayOfPath, initialText, localDay, nearestDay, type DailyNotes } from "./daily.ts";

const extension: ExtensionModule = {
  activate(ctx): DailyNotes {
    const folder = () => ctx.settings.get<string>("daily.folder") ?? "Journal";
    const api: DailyNotes = {
      today: () => localDay(Date.now()),
      pathFor: (day) => dailyPath(folder(), day),
      dayOf: (path) => dayOfPath(folder(), path),
      initial: initialText,
    };
    ctx.commands.register("daily.today", () => openDay(ctx, api, api.today(), true));
    const step = (by: -1 | 1) => async () => {
      const from = api.dayOf(ctx.workbench.focusedPath() ?? "") ?? api.today();
      const days = (await ctx.files.fetchList()).flatMap((f) => api.dayOf(f.path) ?? []);
      const day = nearestDay(days, from, by);
      if (day) await openDay(ctx, api, day, false);
      else ctx.workbench.notice(by < 0 ? "There's no daily note before this one" : "There's no daily note after this one");
    };
    ctx.commands.register("daily.previous", step(-1));
    ctx.commands.register("daily.next", step(1));
    return api;
  },
};

export default extension;

/** Open a day's note; today's is made, with its date as its title, if it isn't there yet. */
async function openDay(ctx: ExtensionContext, api: DailyNotes, day: string, make: boolean) {
  const path = api.pathFor(day) as FilePath;
  if (make) {
    const file = await ctx.files.read(path);
    if (file.revision === 0) await ctx.files.write(path, api.initial(day), 0);
  }
  await ctx.workbench.open(path);
}
