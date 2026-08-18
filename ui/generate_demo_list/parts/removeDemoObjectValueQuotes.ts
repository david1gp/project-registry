export function removeDemoObjectValueQuotes(input: string): string {
  const regex = /(\s*"[^"]+"\s*:\s*)"([^"]+)"(\s*)/g
  return input.replace(regex, "$1$2$3")
}

// test("removeObjectValueQuotes", () => {})
// const given = `
// {
//   "ui_toast": {
//     "DemoToaster": "DemoToaster"
//   },
//   "ui_interactive": {
//     "DemosUiInteractive": "DemosUiInteractive"
//   },
//   "learning_solid": {
//     "DemosLearningSolid": "DemosLearningSolid"
//   },
//   "app_setup": {
//     "DemoConvexCounterApp": "DemoConvexCounterApp"
//   },
//   "ui_input": {
//     "DemosUiInput": "DemosUiInput"
//   },
//   "ui_table": {
//     "DemosUiTable": "DemosUiTable"
//   }
// }
// `
// const got = removeObjectValueQuotes(given)
// console.log(got)
