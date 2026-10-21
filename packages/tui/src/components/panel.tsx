import { Box, Text } from 'ink';
import { fit } from '../text.js';

export interface DisplayLine { text: string; dim?: boolean; bold?: boolean; selected?: boolean; failed?: boolean }

export function Panel({ title, width, height, focused = false, lines, noColor = false }: {
  title: string;
  width: number;
  height: number;
  focused?: boolean;
  lines: DisplayLine[];
  noColor?: boolean;
}) {
  const inner = Math.max(0, width - 4);
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} overflow="hidden">
      <Text color={!noColor && focused ? 'blueBright' : undefined}>{`┌─${fit(` ${title} `, Math.max(0, width - 4)).replace(/ +$/, (spaces) => '─'.repeat(spaces.length))}─┐`}</Text>
      {Array.from({ length: Math.max(0, height - 2) }, (_, index) => {
        const line = lines[index];
        return <Text key={index} dimColor={!noColor && line?.dim} bold={!noColor && line?.bold} inverse={!noColor && line?.selected} color={!noColor && line?.failed ? 'redBright' : undefined}>{`│ ${fit(line?.text ?? '', inner)} │`}</Text>;
      })}
      <Text color={!noColor && focused ? 'blueBright' : undefined}>{`└${'─'.repeat(Math.max(0, width - 2))}┘`}</Text>
    </Box>
  );
}
