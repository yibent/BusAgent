import * as Primitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
export const TooltipProvider = Primitive.Provider;
export function Tip({
  children,
  label,
  side,
}: {
  children: ReactNode;
  label: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content className="ui-tooltip" side={side} sideOffset={7}>
          {label}
          <Primitive.Arrow />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
