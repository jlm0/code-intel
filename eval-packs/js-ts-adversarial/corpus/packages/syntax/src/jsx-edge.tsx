type AnyProps = Record<string, unknown>;

export function PrimaryPanel(props: AnyProps): JSX.Element {
  return <section data-role="primary" {...props} />;
}

export function SecondaryPanel(props: AnyProps): JSX.Element {
  return <section data-role="secondary" {...props} />;
}

export function FragmentList({ items }: { items: string[] }): JSX.Element {
  return (
    <>
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </>
  );
}

export function DynamicSwitch({ primary, ...rest }: { primary: boolean } & AnyProps): JSX.Element {
  const Component = primary ? PrimaryPanel : SecondaryPanel;
  return <Component {...rest} />;
}
