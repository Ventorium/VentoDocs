import { useParams } from 'react-router'
import DirectoryView from './components/DirectoryView'

/** 子目录浏览页：/app/files/{id}。 */
const FilesDir = () => {
  const { id } = useParams<{ id: string }>()
  return <DirectoryView dirId={id ?? null} />
}

export default FilesDir
