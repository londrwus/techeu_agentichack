import { Toaster as Sonner } from "sonner";

const Toaster = ({ ...props }) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={{
        "--normal-bg": "var(--ink)",
        "--normal-text": "#fff",
        "--normal-border": "var(--ink)",
      }}
      {...props}
    />
  );
};

export { Toaster }
