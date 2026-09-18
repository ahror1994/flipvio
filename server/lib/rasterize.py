import sys, os, json
from pathlib import Path
from PIL import Image
import warnings

Image.MAX_IMAGE_PIXELS = 20000000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def process_pdf(pdf_path, out_root, public_base, dpi_normal=110, dpi_large=200):
    import pymupdf
    doc = pymupdf.open(pdf_path)
    pages_count = len(doc)
    if pages_count < 1 or pages_count > 1000:
        raise ValueError('PDF exceeds page limits')
    for page in doc:
        if page.rect.width * page.rect.height * (dpi_large / 72.0) ** 2 > 40000000:
            raise ValueError('PDF exceeds pixel limits')
    normal_dir = Path(out_root) / 'normal'
    large_dir = Path(out_root) / 'large'
    thumb_dir = Path(out_root) / 'thumb'
    for d in (normal_dir, large_dir, thumb_dir):
        d.mkdir(parents=True, exist_ok=True)
        
    first_page = doc[0]
    rect = first_page.rect
    pt_width, pt_height = rect.width, rect.height
    
    # Render tiers
    # DPI: 72 is 1.0 scale
    scale_normal = dpi_normal / 72.0
    scale_large = dpi_large / 72.0
    
    first_px = None
    for i, page in enumerate(doc, 1):
        # normal
        pix_n = page.get_pixmap(matrix=pymupdf.Matrix(scale_normal, scale_normal), alpha=False)
        im_n = Image.frombytes('RGB', (pix_n.width, pix_n.height), pix_n.samples)
        im_n.save(normal_dir / f'page-{i}.jpg', 'JPEG', quality=82, progressive=True, optimize=True)
        if i == 1:
            first_px = {'width': pix_n.width, 'height': pix_n.height}
            
        # large
        pix_l = page.get_pixmap(matrix=pymupdf.Matrix(scale_large, scale_large), alpha=False)
        im_l = Image.frombytes('RGB', (pix_l.width, pix_l.height), pix_l.samples)
        im_l.save(large_dir / f'page-{i}.jpg', 'JPEG', quality=88, progressive=True, optimize=True)
        
        # thumb from normal
        thumb_height = 220
        thumb_width = round(pix_n.width * (thumb_height / pix_n.height))
        im_t = im_n.resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
        im_t.save(thumb_dir / f'page-{i}.jpg', 'JPEG', quality=78)

    pages = []
    for i in range(1, pages_count + 1):
        pages.append({
            'index': i,
            'thumb': f'{public_base}/thumb/page-{i}.jpg',
            'normal': f'{public_base}/normal/page-{i}.jpg',
            'large': f'{public_base}/large/page-{i}.jpg'
        })
        
    result = {
        'pageCount': pages_count,
        'page': first_px or {'width': 800, 'height': 1131},
        'pt': {'width': pt_width, 'height': pt_height},
        'pages': pages
    }
    print(json.dumps(result))

def process_images(image_paths, out_root, public_base):
    normal_dir = Path(out_root) / 'normal'
    large_dir = Path(out_root) / 'large'
    thumb_dir = Path(out_root) / 'thumb'
    for d in (normal_dir, large_dir, thumb_dir):
        d.mkdir(parents=True, exist_ok=True)
        
    first_px = None
    for i, img_path in enumerate(image_paths, 1):
        with Image.open(img_path) as src:
            im = src.convert('RGB')
            w, h = im.size
            ratio = h / w
            
            # normal x1200>
            hn = min(1200, h)
            wn = round(hn / ratio)
            im_n = im.resize((wn, hn), Image.Resampling.LANCZOS)
            im_n.save(normal_dir / f'page-{i}.jpg', 'JPEG', quality=82)
            if i == 1:
                first_px = {'width': wn, 'height': hn}
                
            # large x2200>
            hl = min(2200, h)
            wl = round(hl / ratio)
            im_l = im.resize((wl, hl), Image.Resampling.LANCZOS)
            im_l.save(large_dir / f'page-{i}.jpg', 'JPEG', quality=88)
            
            # thumb x220
            ht = 220
            wt = round(ht / ratio)
            im_t = im.resize((wt, ht), Image.Resampling.LANCZOS)
            im_t.save(thumb_dir / f'page-{i}.jpg', 'JPEG', quality=78)

    pages = []
    for i in range(1, len(image_paths) + 1):
        pages.append({
            'index': i,
            'thumb': f'{public_base}/thumb/page-{i}.jpg',
            'normal': f'{public_base}/normal/page-{i}.jpg',
            'large': f'{public_base}/large/page-{i}.jpg'
        })
        
    result = {
        'pageCount': len(image_paths),
        'page': first_px or {'width': 800, 'height': 1131},
        'pt': None,
        'pages': pages
    }
    print(json.dumps(result))

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'pdf':
        process_pdf(sys.argv[2], sys.argv[3], sys.argv[4])
    elif mode == 'images':
        out_root = sys.argv[2]
        public_base = sys.argv[3]
        img_paths = sys.argv[4:]
        process_images(img_paths, out_root, public_base)
