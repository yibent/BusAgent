import * as Panels from "react-resizable-panels";
import { cn } from "@/lib/utils";
export function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof Panels.PanelGroup>) {
  return (
    <Panels.PanelGroup
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}
export const ResizablePanel = Panels.Panel;
export function ResizableHandle({
  className,
  ...props
}: React.ComponentProps<typeof Panels.PanelResizeHandle>) {
  return (
    <Panels.PanelResizeHandle
      className={cn("resize-handle", className)}
      {...props}
    >
      <span />
    </Panels.PanelResizeHandle>
  );
}
