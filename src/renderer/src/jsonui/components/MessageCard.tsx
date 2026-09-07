import { severityColor } from '../shared/severityColor'

export function MessageCard({
  props,
}: {
  props: { variant: 'info' | 'success' | 'warning' | 'error'; title: string; message: string }
}) {
  return (
    <div className="jui-card" style={{ borderLeftColor: severityColor[props.variant] }}>
      <div className="jui-card-title" style={{ color: severityColor[props.variant] }}>
        {props.title}
      </div>
      <div className="jui-confirm-msg">{props.message}</div>
    </div>
  )
}
