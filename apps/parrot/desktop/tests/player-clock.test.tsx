// @vitest-environment jsdom
// #3350 C4: the playing position redraws only what shows it (Home's Resume card, Now playing), never the library page
// around it, whose song list on a big library cost ~190 ms a draw, once a second, while music played.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlayerClock, withPlayerClock, type PlayerClock } from "../src/renderer/src/playerClock";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[parrot-player-clock]";
const draws = { page: 0, list: 0, clocked: 0 };

function Position({ positionMs, label }: { positionMs: number; label: string }) {
  draws.clocked += 1;
  return <span data-testid="position">{`${label} ${positionMs}`}</span>;
}
const ClockedPosition = withPlayerClock(Position);

function SongList() {
  draws.list += 1;
  return <ol />;
}

function Page({ clock }: { clock: PlayerClock }) {
  draws.page += 1;
  const [list] = useState(() => <SongList />);
  return (
    <main>
      {list}
      <ClockedPosition clock={clock} label="at" />
    </main>
  );
}

describe("[parrot] player clock", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    draws.page = draws.list = draws.clocked = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a tick redraws the position only; the page and its list are drawn once", () => {
    const clock = createPlayerClock();
    act(() => root.render(<Page clock={clock} />));
    const shown = () => container.querySelector('[data-testid="position"]')?.textContent;
    expect(shown()).toBe("at 0");
    for (const ms of [1000, 2000, 3000, 4000, 5000]) act(() => clock.write(ms));
    console.info(SUITE, "after 5 ticks", JSON.stringify(draws), shown());
    expect(shown()).toBe("at 5000");
    expect(draws.page).toBe(1);
    expect(draws.list).toBe(1);
    expect(draws.clocked).toBe(6);
  });

  it("writing the same position again draws nothing", () => {
    const clock = createPlayerClock();
    act(() => root.render(<Page clock={clock} />));
    act(() => clock.write(1000));
    act(() => clock.write(1000));
    expect(draws.clocked).toBe(2);
  });

  it("a position shown after the clock moved starts at the current time", () => {
    const clock = createPlayerClock();
    clock.write(78_000);
    act(() => root.render(<ClockedPosition clock={clock} label="resume" />));
    expect(container.textContent).toBe("resume 78000");
  });
});
