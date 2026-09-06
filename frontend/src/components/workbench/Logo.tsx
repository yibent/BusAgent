export function Logo({
  className = "",
  alt = "",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      className={`liugong-logo ${className}`}
      src="/brand/liugong-logo.png"
      alt={alt}
      draggable={false}
    />
  );
}
