import { createMemo } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"

export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  return (
    <div
      data-component="corro-home"
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div
          class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-x-8 lg:px-6
          `}
        >
          <HomeMasthead
            language={sessions.copy.language}
            sessionCount={() => sessions.data.groups().reduce((total, group) => total + group.sessions.length, 0)}
            onCreateSession={sessions.session.create}
          />
          <HomeProjects projects={projects} scroll={scroll} />
          <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}

function HomeMasthead(props: {
  language: { t: (key: string, params?: Record<string, string | number>) => string }
  sessionCount: () => number
  onCreateSession: () => void
}) {
  const greeting = createMemo(() => {
    const hour = new Date().getHours()
    if (hour < 12) return props.language.t("home.dashboard.morning")
    if (hour < 18) return props.language.t("home.dashboard.afternoon")
    return props.language.t("home.dashboard.evening")
  })
  return (
    <div data-component="corro-masthead" class="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pt-6 lg:col-span-2 lg:pt-10">
      <div class="min-w-0">
        <div class="text-[11px] font-[700] uppercase tracking-[0.14em] text-v2-text-text-accent">Corro Code</div>
        <h1 class="mt-1 truncate text-[26px] font-[750] leading-8 tracking-[-0.02em] text-v2-text-text-base">
          {greeting()}
        </h1>
        <p data-component="corro-stats" class="mt-0.5 text-[13px] font-[440] text-v2-text-text-muted">
          {props.language.t("home.dashboard.recent", { count: props.sessionCount() })}
        </p>
      </div>
      <button
        type="button"
        data-component="corro-cta"
        data-action="home-new-session"
        class={`
          flex h-9 shrink-0 cursor-default items-center gap-1.5 rounded-[10px] border-0 px-4
          text-[13px] font-[600] tracking-[-0.01em] text-white
          transition-all duration-150 ease-in-out hover:-translate-y-px focus-visible:outline-none
        `}
        onClick={props.onCreateSession}
      >
        <IconV2 name="plus" size="small" />
        {props.language.t("command.session.new")}
      </button>
    </div>
  )
}
