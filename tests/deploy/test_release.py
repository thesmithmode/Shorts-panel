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
    for name in ['bin/node','dist/index.html','src/server/index.ts','package.json','node_modules/tsx/package.json']:
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


from unittest.mock import patch
from types import SimpleNamespace

REQUIRED = ['bin/node','dist/index.html','src/server/index.ts','package.json','node_modules/tsx/package.json']

def bundle(names=REQUIRED):
 payload=io.BytesIO()
 with tarfile.open(fileobj=payload,mode='w:gz') as tf:
  for name in names:
   entry=tarfile.TarInfo(name);entry.size=2;entry.mode=0o755 if name=='bin/node' else 0o644;tf.addfile(entry,io.BytesIO(b'{}'))
 payload.seek(0);return payload

class DeployCycleTests(unittest.TestCase):
 """Full receiver cycles against a temporary root: first install, retention, failure cleanup."""
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();base=Path(self.tmp.name)
  self.root=base/'app';self.data=base/'data';self.root.mkdir();self.data.mkdir()
  self.actions=[];self.health=True
 def tearDown(self):self.tmp.cleanup()
 def deploy(self,sha,payload=None,health=None):
  ok=self.health if health is None else health
  with patch.object(release,'ROOT',self.root),patch.object(release,'DATA',self.data),\
   patch.object(release.os,'geteuid',return_value=0),\
   patch.dict(release.os.environ,{'SSH_ORIGINAL_COMMAND':'release '+sha}),\
   patch.object(release.sys,'argv',['release.py']),\
   patch.object(release.sys,'stdin',SimpleNamespace(buffer=payload or bundle())),\
   patch.object(release,'service',side_effect=self.actions.append),\
   patch.object(release,'healthy',return_value=ok),\
   patch.object(release.os,'chown'),\
   patch.object(release.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)):
   release.main()
 def releases(self):
  return sorted(p.name for p in (self.root/'releases').iterdir())
 def test_first_release_installs_without_previous_current(self):
  self.deploy('a'*40)
  self.assertEqual((self.root/'current').resolve(),(self.root/'releases'/('a'*40)).resolve())
  self.assertEqual(self.actions,['stop','start'])
  self.assertEqual(((self.root/'current')/'release-sha').read_text(),'a'*40)
 def test_bundled_runtime_is_required(self):
  with self.assertRaises(ValueError):self.deploy('a'*40,bundle(REQUIRED[1:]))
  self.assertFalse((self.root/'current').exists())
  self.assertEqual(self.releases(),[])
 def test_failed_first_release_leaves_no_garbage_and_can_be_retried(self):
  (self.data/'panel.sqlite').write_bytes(b'db')
  with self.assertRaisesRegex(RuntimeError,'health'):self.deploy('a'*40,health=False)
  self.assertFalse((self.root/'current').is_symlink())
  self.assertEqual(self.releases(),[])
  self.assertEqual((self.data/'panel.sqlite').read_bytes(),b'db')
  self.deploy('a'*40)
  self.assertEqual(self.releases(),['a'*40])
 def test_failed_release_rolls_back_and_is_removed(self):
  self.deploy('a'*40)
  with self.assertRaisesRegex(RuntimeError,'health'):self.deploy('b'*40,health=False)
  self.assertEqual((self.root/'current').resolve().name,'a'*40)
  self.assertEqual(self.releases(),['a'*40])
 def test_only_three_releases_and_checkpoints_are_kept(self):
  import os
  for i,c in enumerate('abcde'):
   self.deploy(c*40)
   for p in (self.root/'releases').iterdir():
    if p.name==c*40:os.utime(p,(1000+i,1000+i))
  self.assertEqual(self.releases(),['c'*40,'d'*40,'e'*40])
  self.assertEqual((self.root/'current').resolve().name,'e'*40)
  self.assertLessEqual(len(list((self.root/'checkpoints').iterdir())),3)
  self.assertEqual([p for p in (self.root/'releases').iterdir() if p.name.startswith('.')],[])
 def test_redeploying_current_release_is_idempotent(self):
  self.deploy('a'*40);self.actions.clear()
  self.deploy('a'*40)
  self.assertEqual(self.actions,[])
  self.assertEqual(self.releases(),['a'*40])
