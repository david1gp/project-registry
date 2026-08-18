import { mdiCheck, mdiMagnify, mdiUndo } from "@mdi/js"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { ButtonIcon } from "#ui/interactive/button/ButtonIcon.jsx"
import { buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { SignalObject } from "#ui/utils/createSignalObject.js"

export interface SearchFilterEntry {
  key: string
  label: string
  valueSignal: SignalObject<string>
  getOptions: () => string[]
  getOptionText?: (value: string) => string
  isSearchable?: boolean
  icon?: string
  buttonVariant?: typeof buttonVariant.filled | typeof buttonVariant.outline
}

export interface SearchBoxProps {
  searchQuerySignal: SignalObject<string>
  filters: SearchFilterEntry[]
  onSearch: () => void | Promise<void>
  placeholder?: string
  searchButtonText?: string
  scrollToId?: string
}

/** Search input with filter dropdowns and search button. */
export function SearchBox(p: SearchBoxProps) {
  const [activeFilterKey, setActiveFilterKey] = createSignal<string | null>(null)

  let containerRef: HTMLDivElement | undefined

  const handleClickOutside = (event: MouseEvent) => {
    if (containerRef && !containerRef.contains(event.target as Node)) {
      setActiveFilterKey(null)
    }
  }

  document.addEventListener("mousedown", handleClickOutside)
  onCleanup(() => document.removeEventListener("mousedown", handleClickOutside))

  const handleFilterClick = (key: string) => {
    if (activeFilterKey() === key) {
      setActiveFilterKey(null)
    } else {
      setActiveFilterKey(key)
    }
  }

  const handleOptionSelect = (filter: SearchFilterEntry, value: string) => {
    filter.valueSignal.set(value)
    setActiveFilterKey(null)
  }

  const handleClear = () => {
    clearAllFilters(p.filters)
    setActiveFilterKey(null)
  }

  const activeFilter = () => p.filters.find((f) => f.key === activeFilterKey())

  return (
    <div ref={containerRef} class="relative z-[120] isolate max-w-3xl mx-auto">
      <div class="relative rounded-[22px] bg-white dark:bg-slate-700 p-5 backdrop-blur-2xl sm:p-7 border border-slate-200 dark:border-slate-600">
        <SearchInput searchQuerySignal={p.searchQuerySignal} placeholder={p.placeholder} />

        <FilterButtons
          filters={p.filters}
          activeFilterKey={activeFilterKey}
          onFilterClick={handleFilterClick}
          onClear={handleClear}
        />

        <Show when={activeFilterKey()}>
          <div class="absolute left-0 right-0 top-full z-[300] mt-3 rounded-2xl p-0">
            <Show
              when={activeFilter()}
              children={
                <FilterDropdown
                  filter={activeFilter()!}
                  isActive={true}
                  onSelect={(value) => activeFilter() && handleOptionSelect(activeFilter()!, value)}
                />
              }
            />
          </div>
        </Show>

        <SearchButton onSearch={p.onSearch} scrollToId={p.scrollToId} searchButtonText={p.searchButtonText} />
      </div>
    </div>
  )
}

function getOptionText(entry: SearchFilterEntry, value: string): string {
  if (!value) return ""
  if (entry.getOptionText) return entry.getOptionText(value)
  return value
}

function hasActiveFilters(filters: SearchFilterEntry[]): boolean {
  return filters.some((f) => f.valueSignal.get() !== "")
}

function clearAllFilters(filters: SearchFilterEntry[]) {
  filters.forEach((f) => {
    f.valueSignal.set("")
  })
}

function filterOptions(options: string[], query: string): string[] {
  if (!query.trim()) return options
  const lowerQuery = query.toLowerCase()
  return options.filter((opt) => opt.toLowerCase().includes(lowerQuery))
}

function SearchInput(p: { searchQuerySignal: SignalObject<string>; placeholder?: string }) {
  return (
    <div class="mb-5">
      <div class="relative group">
        <Icon
          path={mdiMagnify}
          class="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-gray-500 group-focus-within:text-blue-500 transition-colors"
        />
        <input
          type="text"
          placeholder={p.placeholder ?? "Search..."}
          value={p.searchQuerySignal.get()}
          onInput={(e) => p.searchQuerySignal.set(e.currentTarget.value)}
          class="w-full pl-11 pr-4 py-3.5 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent focus:bg-white dark:focus:bg-slate-900 transition-all text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500"
        />
      </div>
    </div>
  )
}

function FilterDropdown(p: { filter: SearchFilterEntry; isActive: boolean; onSelect: (value: string) => void }) {
  const [filterQuery, setFilterQuery] = createSignal("")

  const filteredOptions = () => filterOptions(p.filter.getOptions(), filterQuery())
  const isSelected = (option: string) => p.filter.valueSignal.get() === option

  return (
    <div class="w-full overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
      <Show when={p.filter.isSearchable}>
        <div class="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
          <div class="shrink-0 text-sm font-semibold text-slate-900 dark:text-slate-100">{p.filter.label}</div>
          <div class="flex-1">
            <input
              type="text"
              value={filterQuery()}
              onInput={(e) => setFilterQuery(e.currentTarget.value)}
              placeholder={`Search ${p.filter.label}`}
              class="h-10 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 text-sm text-slate-900 dark:text-slate-100 outline-none transition focus:border-emerald-300 dark:focus:border-emerald-600 focus:bg-white dark:focus:bg-slate-900 placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
          </div>
        </div>
      </Show>

      <Show when={!p.filter.isSearchable}>
        <div class="border-b border-slate-100 dark:border-slate-800 px-4 py-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {p.filter.label}
        </div>
      </Show>

      <div
        class="touch-pan-y"
        style={{
          height: "18rem",
          "overflow-y": "scroll",
          "overscroll-behavior": "contain",
          "-webkit-overflow-scrolling": "touch",
        }}
      >
        <For each={filteredOptions()}>
          {(option) => (
            <button
              type="button"
              role="option"
              aria-selected={isSelected(option)}
              onClick={() => p.onSelect(option)}
              class={classMerge(
                "flex w-full items-center justify-between border-t border-slate-100 dark:border-slate-800 px-4 py-2.5 text-left text-sm transition-colors",
                isSelected(option)
                  ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-900 dark:text-emerald-100"
                  : "text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800",
              )}
            >
              <span>{getOptionText(p.filter, option)}</span>
              <Show when={isSelected(option)}>
                <span class="text-emerald-600 dark:text-emerald-400">
                  <Icon path={mdiCheck} class="h-4 w-4" />
                </span>
              </Show>
            </button>
          )}
        </For>

        <Show when={filteredOptions().length === 0}>
          <div class="px-4 py-4 text-sm text-slate-500 dark:text-slate-400">No results found.</div>
        </Show>
      </div>
    </div>
  )
}

function FilterButtons(p: {
  filters: SearchFilterEntry[]
  activeFilterKey: () => string | null
  onFilterClick: (key: string) => void
  onClear: () => void
}) {
  return (
    <div class="mb-6 space-y-3">
      <div class="relative z-[140] isolate">
        <div class="flex items-stretch gap-2.5 pb-1">
          <For each={p.filters}>
            {(filter) => (
              <ButtonIcon
                type="button"
                icon={filter.icon}
                variant={
                  isButtonActive(filter) ? buttonVariant.filled : (filter.buttonVariant ?? buttonVariant.outline)
                }
                aria-pressed={p.activeFilterKey() === filter.key}
                onClick={() => p.onFilterClick(filter.key)}
                class="min-w-0 flex-1 justify-center rounded-full border text-sm font-medium shadow-sm"
              >
                <span class="min-w-0 truncate">{getButtonText(filter)}</span>
              </ButtonIcon>
            )}
          </For>

          <Show when={hasActiveFilters(p.filters)}>
            <ButtonIcon
              type="button"
              icon={mdiUndo}
              variant={buttonVariant.outline}
              onClick={p.onClear}
              class="min-h-11 items-center justify-center rounded-full border px-3 py-2 text-sm font-medium shadow-sm sm:px-4"
              aria-label="Clear filters"
            />
          </Show>
        </div>
      </div>
    </div>
  )
}

function SearchButton(p: { onSearch: () => void | Promise<void>; scrollToId?: string; searchButtonText?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        p.onSearch()
        if (p.scrollToId) {
          document.getElementById(p.scrollToId)?.scrollIntoView({ behavior: "smooth" })
        }
      }}
      class="w-full py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-emerald-500 text-white shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:brightness-110 transition-all flex items-center justify-center gap-2"
    >
      <Icon path={mdiMagnify} class="w-5 h-5 fill-white" />
      {p.searchButtonText ?? "Search"}
    </button>
  )
}

function isButtonActive(filter: SearchFilterEntry): boolean {
  return filter.valueSignal.get() !== ""
}

function getButtonText(filter: SearchFilterEntry): string {
  const value = filter.valueSignal.get()
  if (!value) return filter.label
  return getOptionText(filter, value)
}
