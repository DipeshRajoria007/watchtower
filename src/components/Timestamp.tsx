import { formatTimestamp, formatTimestampFull } from '../lib/formatters';

export function Timestamp({ value }: { value: string }) {
  return (
    <time dateTime={value} title={formatTimestampFull(value)}>
      {formatTimestamp(value)}
    </time>
  );
}
