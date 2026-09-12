#!/usr/bin/env bash
set -euo pipefail

cli="${PROJECT_REGISTRY_CLI:-project-registry}"
socket="${PROJECT_REGISTRY_SOCKET:-}"
apply=false

usage() {
  printf '%s\n' "Usage: $0 [--apply] [--dry-run] [--cli PATH] [--socket PATH]"
  printf '%s\n' "Defaults to a read-only plan. --apply edits only the section label."
}

while (($# > 0)); do
  case "$1" in
    --apply)
      apply=true
      ;;
    --dry-run)
      apply=false
      ;;
    --cli)
      (($# >= 2)) || { printf '%s\n' '--cli requires a path' >&2; exit 2; }
      cli="$2"
      shift
      ;;
    --socket)
      (($# >= 2)) || { printf '%s\n' '--socket requires a path' >&2; exit 2; }
      socket="$2"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

normalizations=(
  'sales|Interne'
  'sales-api|Interne'
  'sales-web-preview|Interne'
  'sales-web-prod|Interne'
  'billing|Interne'
  'billing-preview|Interne'
  'akademie|Eigene'
  'akademie-api|Eigene'
  'akademie-dev-api|Eigene'
  'akademie-prod|Eigene'
)

project_exists() {
  local project="$1"
  local output
  local status
  local command=("$cli" project get "$project" --json)
  if [[ -n "$socket" ]]; then command+=(--socket "$socket"); fi

  if output=$("${command[@]}" 2>&1); then
    return 0
  fi

  status=$?
  if [[ "$output" == *'"status":404'* || "$output" == *'"status": 404'* ]]; then
    printf 'skip missing project: %s\n' "$project"
    return 3
  fi
  printf '%s\n' "$output" >&2
  return "$status"
}

for normalization in "${normalizations[@]}"; do
  IFS='|' read -r project section <<<"$normalization"
  if project_exists "$project"; then
    :
  else
    status=$?
    if [[ "$status" -eq 3 ]]; then continue; fi
    exit "$status"
  fi

  command=("$cli" project edit "$project" --label "section=$section")
  if [[ -n "$socket" ]]; then command+=(--socket "$socket"); fi
  if [[ "$apply" == true ]]; then
    "${command[@]}"
  else
    printf 'dry-run:'
    printf ' %q' "${command[@]}"
    printf '\n'
  fi
done
