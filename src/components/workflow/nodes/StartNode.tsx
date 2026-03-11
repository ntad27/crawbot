import { Handle, Position } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

export function StartNode() {
  const { t } = useTranslation('workflow');
  return (
    <div className="flex items-center justify-center w-24 h-10 rounded-full bg-green-500 dark:bg-green-600 text-white text-sm font-semibold shadow-md select-none">
      {t('visual.start')}
      <Handle type="source" position={Position.Bottom} className="!bg-green-700" />
    </div>
  );
}
