import type { Component, JSX } from "solid-js"
import { createMemo, splitProps } from "solid-js"
import sprite from "./provider-icons/sprite.svg"
import { iconNames, type IconName } from "./provider-icons/types"

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const resolved = createMemo(() => {
    const id = local.id === "ollama" ? "ollama-cloud" : local.id
    return iconNames.includes(id as IconName) ? id : "synthetic"
  })
  return (
    <svg
      data-component="provider-icon"
      {...rest}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={`${sprite}#${resolved()}`} />
    </svg>
  )
}
