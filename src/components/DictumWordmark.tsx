/* eslint-disable i18next/no-literal-string -- Dictum is an unlocalized product name. */
interface DictumWordmarkProps {
  width?: number;
  className?: string;
}

const DictumWordmark = ({ width, className }: DictumWordmarkProps) => (
  <div
    className={`dictum-wordmark ${className ?? ""}`}
    data-testid="dictum-wordmark"
    style={width ? { width } : undefined}
  >
    Dictum
  </div>
);

export default DictumWordmark;
