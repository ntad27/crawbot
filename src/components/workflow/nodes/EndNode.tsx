import { Handle, Position } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

export function EndNode() {
  const { t } = useTranslation('workflow');
  return (
    <div className="flex items-center justify-center w-24 h-10 rounded-full bg-red-500 dark:bg-red-600 text-white text-sm font-semibold shadow-md select-none">
      <Handle type="target" position={Position.Top} className="!bg-red-700" />
      {t('visual.end')}
    </div>
  );
}
