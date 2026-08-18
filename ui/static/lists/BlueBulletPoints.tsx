import { BlackBulletPoints, type BlackBulletPointsProps } from "#ui/static/lists/BlackBulletPoints.jsx"

/** List of text items with blue bullets. */
export function BlueBulletPoints(p: BlackBulletPointsProps) {
  return <BlackBulletPoints classBullet="text-blue-500 dark:text-blue-500" {...p} />
}
