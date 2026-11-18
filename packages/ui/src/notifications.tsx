import { Toaster, toast, type ExternalToast } from "sonner";

export { toast, type ExternalToast };

export const Notifications = () => (
  <Toaster
    closeButton
    duration={4000}
    position="top-right"
    offset={96}
    richColors
    expand={false}
  />
);
