import { classArr } from "#ui/utils/classArr.js"

export const classesPageHeightFull = "min-h-[80svh] sm:min-h-[90svh]"

export const classesPageCentered = classArr(
  "flex flex-col justify-center items-center my-auto", // align center
)

export const classesPageCenteredFull = classArr(
  "flex flex-col justify-center items-center my-auto", // align center
  classesPageHeightFull,
)
