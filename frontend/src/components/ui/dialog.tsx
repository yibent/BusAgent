import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
export const Dialog = Primitive.Root;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export function DialogContent({ children }: { children: ReactNode }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="ui-dialog-overlay" />
      <Primitive.Content className="ui-dialog-content">
        {children}
        <Primitive.Close className="icon-button dialog-close" aria-label="关闭">
          <X size={16} />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
