import { cn } from "../../lib/utils"
import { Loader2 as Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon role="status" aria-label="Loading" className={cn("size-4 animate-spin [&_path]:stroke-current", className)} {...props} />
  )
}

export { Spinner }
