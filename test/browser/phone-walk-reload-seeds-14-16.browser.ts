// Random walks on a phone (phone-history.ts says what they check), a few seeds to a file so they run side by side.
import { harness } from "./harness.ts";
import { randomWalks } from "./phone-history.ts";

randomWalks(harness(), [14, 15, 16], { reloads: true });
