import importlib.util, io, tarfile, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('release',Path(__file__).parents[2]/'ops/release.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
class ReleaseTests(unittest.TestCase):
 def archive(self,name='dist/index.html',kind=None,link=''):
  buffer=io.BytesIO()
  with tarfile.open(fileobj=buffer,mode='w:gz') as tf:
   info=tarfile.TarInfo(name);data=b'ok';info.size=len(data)
   if kind:info.type=kind;info.linkname=link;info.size=0
   tf.addfile(info,io.BytesIO(data) if not kind else None)
  buffer.seek(0);return buffer
 def test_unsafe_members_rejected_before_any_extraction(self):
  for name,kind,link in [('../escape',None,''),('/etc/passwd',None,''),('src/key',tarfile.SYMTYPE,'/etc/passwd'),('dist/pipe',tarfile.FIFOTYPE,''),('data/panel.sqlite',None,'')]:
   with self.subTest(name=name),tempfile.TemporaryDirectory() as tmp:
    with self.assertRaises(ValueError):release.extract_release(self.archive(name,kind,link),Path(tmp))
    self.assertEqual(list(Path(tmp).iterdir()),[])
 def test_valid_archive_extracted(self):
  with tempfile.TemporaryDirectory() as tmp:
   release.extract_release(self.archive(),Path(tmp));self.assertEqual((Path(tmp)/'dist/index.html').read_bytes(),b'ok')
 def test_only_exact_sha_command(self):
  self.assertEqual(release.parse_command('release '+'a'*40),'a'*40)
  for cmd in ['release main','release '+'a'*40+'; reboot','deploy '+'a'*40,'release '+'a'*39]:
   with self.assertRaises(ValueError):release.parse_command(cmd)
 def test_duplicate_members_rejected(self):
  buffer=io.BytesIO()
  with tarfile.open(fileobj=buffer,mode='w:gz') as tf:
   for _ in range(2):tf.addfile(tarfile.TarInfo('package.json'),io.BytesIO())
  buffer.seek(0)
  with tempfile.TemporaryDirectory() as tmp:
   with self.assertRaises(ValueError):release.extract_release(buffer,Path(tmp))
 def test_normalized_duplicate_members_rejected(self):
  buffer=io.BytesIO()
  with tarfile.open(fileobj=buffer,mode='w:gz') as tf:
   for name in ['dist/index.html','dist/./index.html']:tf.addfile(tarfile.TarInfo(name),io.BytesIO())
  buffer.seek(0)
  with tempfile.TemporaryDirectory() as tmp:
   with self.assertRaises(ValueError):release.extract_release(buffer,Path(tmp))
   self.assertEqual(list(Path(tmp).iterdir()),[])
 def test_failed_health_restores_previous_release_and_state(self):
  from unittest.mock import patch
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)/'app';data=Path(tmp)/'data';root.mkdir();data.mkdir()
   previous=root/'releases'/('b'*40);previous.mkdir(parents=True);(root/'current').symlink_to(previous)
   (data/'panel.sqlite').write_bytes(b'old database');(data/'secret.key').write_bytes(b'old key')
   payload=io.BytesIO()
   with tarfile.open(fileobj=payload,mode='w:gz') as tf:
    for name in ['dist/index.html','src/server/index.ts','package.json','node_modules/tsx/package.json']:
     entry=tarfile.TarInfo(name);entry.size=2;tf.addfile(entry,io.BytesIO(b'{}'))
   payload.seek(0);actions=[]
   def service(action):
    actions.append(action)
    if len(actions)==2:(data/'panel.sqlite').write_bytes(b'new incompatible database')
   with patch.object(release,'ROOT',root),patch.object(release,'DATA',data),patch.object(release.os,'geteuid',return_value=0),patch.dict(release.os.environ,{'SSH_ORIGINAL_COMMAND':'release '+'a'*40}),patch.object(release.sys,'stdin',SimpleNamespace(buffer=payload)),patch.object(release,'service',side_effect=service),patch.object(release,'healthy',return_value=False),patch.object(release.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)):
    with self.assertRaisesRegex(RuntimeError,'health'):release.main()
   self.assertEqual((root/'current').resolve(),previous)
   self.assertEqual((data/'panel.sqlite').read_bytes(),b'old database')
   self.assertEqual((data/'secret.key').read_bytes(),b'old key')
   self.assertEqual(actions,['stop','start','stop','start'])
